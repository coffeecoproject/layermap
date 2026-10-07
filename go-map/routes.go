package main

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"regexp"
	"strconv"
	"strings"
)

// A path, optionally after a method, as route patterns are written: "/v1/users", "GET /v1/users";
// a sentence that starts with a slash, as a test's name can, is not one.
var pathPattern = regexp.MustCompile(`^(?:[A-Z]+ +)?/\S*$`)

// HTTP request methods, as route registrations name them.
var httpMethods = map[string]bool{
	"GET": true, "HEAD": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true,
	"OPTIONS": true, "CONNECT": true, "TRACE": true,
}

type routeSpan struct {
	start, end int
	// The route the expression is registered under: its methods, if known, then its path.
	label string
	// The path alone, which registrations inside a function literal here extend; empty when the
	// registration names methods, as a handler's does.
	prefix string
	// What executes the registering expression; code inside a function literal there does not.
	owner int
}

// pathConstant is the value of a string constant that spells a path.
func (w *walker) pathConstant(expr ast.Expr) (string, bool) {
	value := ""
	if tv, ok := w.u.info.Types[expr]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		value = constant.StringVal(tv.Value)
	} else if lit, ok := unparen(expr).(*ast.BasicLit); ok && lit.Kind == token.STRING {
		// The checker leaves the arguments of a call into an unloaded package unchecked.
		unquoted, err := strconv.Unquote(lit.Value)
		if err != nil {
			return "", false
		}
		value = unquoted
	}
	if len(value) > 256 || !pathPattern.MatchString(value) {
		return "", false
	}
	return value, true
}

// Standard library packages whose functions take file system paths, never routes:
// filepath.Walk("/var/data", visit) or os.WriteFile("/tmp/out", render(), 0644).
var filePathPackages = map[string]bool{
	"os": true, "os/exec": true, "io/fs": true, "io/ioutil": true, "path": true,
	"path/filepath": true, "syscall": true, "plugin": true,
}

// routeCall registers the arguments after a call's first path constant under that path, as
// mux.HandleFunc("/v1/users", listUsers) or mux.Handle("/v1/", api(repo)) register handlers.
func (w *walker) routeCall(call *ast.CallExpr) {
	if selector, ok := unparen(call.Fun).(*ast.SelectorExpr); ok {
		if name, ok := selector.X.(*ast.Ident); ok {
			if imported, ok := w.u.info.Uses[name].(*types.PkgName); ok &&
				filePathPackages[imported.Imported().Path()] {
				return
			}
		}
	}
	w.chainedMethods(call)
	selector, _ := unparen(call.Fun).(*ast.SelectorExpr)
	for i, argument := range call.Args {
		if path, ok := w.pathConstant(argument); ok {
			var receiver ast.Expr
			if selector != nil {
				receiver = selector.X
			}
			label, prefix := w.routeLabel(call, receiver, path, call.Args[i+1:])
			for _, registered := range call.Args[i+1:] {
				w.route(registered, label, prefix)
			}
			return
		}
	}
	// A handler attached to a route set up by the call before it, as in
	// r.Path("/v1/users").HandlerFunc(list) or r.PathPrefix("/static/").Handler(files).
	if selector == nil || !w.registersHandler(call.Args) {
		return
	}
	setup, ok := unparen(selector.X).(*ast.CallExpr)
	if !ok || len(setup.Args) != 1 {
		return
	}
	path, ok := w.pathConstant(setup.Args[0])
	if !ok {
		return
	}
	var receiver ast.Expr
	if inner, ok := unparen(setup.Fun).(*ast.SelectorExpr); ok {
		receiver = inner.X
	}
	label, prefix := w.routeLabel(call, receiver, path, call.Args)
	for _, registered := range call.Args {
		w.route(registered, label, prefix)
	}
}

// chainedMethods records the methods a call adds to the registration it is chained to, as
// r.HandleFunc("/v1/users", list).Methods(http.MethodGet) does: every constant argument names one.
func (w *walker) chainedMethods(call *ast.CallExpr) {
	selector, ok := unparen(call.Fun).(*ast.SelectorExpr)
	if !ok || len(call.Args) == 0 {
		return
	}
	var methods []string
	for _, argument := range call.Args {
		method, ok := w.methodConstant(argument)
		if !ok {
			return
		}
		methods = append(methods, method)
	}
	// Each call it is chained to may be the registration: .Methods(…) can follow .Name(…).
	for inner := unparen(selector.X); ; {
		chained, ok := inner.(*ast.CallExpr)
		if !ok {
			return
		}
		w.methods[chained] = append(w.methods[chained], methods...)
		receiver, ok := unparen(chained.Fun).(*ast.SelectorExpr)
		if !ok {
			return
		}
		inner = unparen(receiver.X)
	}
}

// methodConstant is the HTTP method a constant names: "PUT", or net/http's MethodPut, whose value
// is known even when the standard library's types are not loaded.
func (w *walker) methodConstant(expr ast.Expr) (string, bool) {
	value := ""
	if tv, ok := w.u.info.Types[expr]; ok && tv.Value != nil && tv.Value.Kind() == constant.String {
		value = constant.StringVal(tv.Value)
	} else if lit, ok := unparen(expr).(*ast.BasicLit); ok && lit.Kind == token.STRING {
		value, _ = strconv.Unquote(lit.Value)
	} else if selector, ok := unparen(expr).(*ast.SelectorExpr); ok {
		if name, ok := selector.X.(*ast.Ident); ok {
			if imported, ok := w.u.info.Uses[name].(*types.PkgName); ok &&
				imported.Imported().Path() == "net/http" && strings.HasPrefix(selector.Sel.Name, "Method") {
				value = strings.ToUpper(strings.TrimPrefix(selector.Sel.Name, "Method"))
			}
		}
	}
	return value, httpMethods[value]
}

// routeLabel joins a registration's path with the prefix its router carries and the methods it
// is registered for. Both come only from constants the registration's own function shows: a
// prefix set on a router passed in from elsewhere is not known here.
func (w *walker) routeLabel(call *ast.CallExpr, receiver ast.Expr, path string, registered []ast.Expr) (string, string) {
	method := ""
	if space := strings.IndexByte(path, ' '); space > 0 {
		method, path = path[:space], strings.TrimLeft(path[space:], " ")
	}
	full := path
	if receiver != nil {
		full = joinRoute(w.routerPrefix(receiver, 0), path)
	}
	// r.Get("/v1/users", list): the registering method is named for the HTTP method.
	if selector, ok := unparen(call.Fun).(*ast.SelectorExpr); ok && method == "" {
		if name := strings.ToUpper(selector.Sel.Name); httpMethods[name] && w.registersHandler(registered) {
			method = name
		}
	}
	if methods := w.methods[call]; method == "" && len(methods) > 0 {
		method = strings.Join(methods, "|")
	}
	label := full
	if method != "" {
		label = method + " " + full
	}
	if len(label) > 256 {
		label = path
	}
	if method != "" {
		return label, ""
	}
	return label, full
}

// registersHandler reports whether a registration passes something that can handle a request: a
// function, a value with a ServeHTTP method, or a value whose type is not loaded.
func (w *walker) registersHandler(registered []ast.Expr) bool {
	for _, expr := range registered {
		tv, ok := w.u.info.Types[expr]
		if !ok || !validType(tv.Type) {
			return true
		}
		if _, ok := tv.Type.Underlying().(*types.Signature); ok {
			return true
		}
		if object, _, _ := types.LookupFieldOrMethod(tv.Type, true, nil, "ServeHTTP"); object != nil {
			return true
		}
	}
	return false
}

// routerPrefix is the path a router expression adds to the routes registered on it: the path
// constants of the calls that made it, as r.PathPrefix("/v1").Subrouter() does, followed through
// local variables assigned once, or the route of the function literal it was passed to, as in
// r.Route("/v1", func(r chi.Router) { … }).
func (w *walker) routerPrefix(expr ast.Expr, depth int) string {
	if depth > 8 {
		return ""
	}
	switch e := unparen(expr).(type) {
	case *ast.CallExpr:
		// Only methods of a router make prefixes: a function given a path, as
		// server.New("/run/app.sock") is, makes something else.
		selector, ok := unparen(e.Fun).(*ast.SelectorExpr)
		if !ok {
			return ""
		}
		if name, ok := unparen(selector.X).(*ast.Ident); ok {
			if _, imported := w.u.info.Uses[name].(*types.PkgName); imported {
				return ""
			}
		}
		base := w.routerPrefix(selector.X, depth+1)
		for _, argument := range e.Args {
			if path, ok := w.pathConstant(argument); ok {
				if strings.IndexByte(path, ' ') >= 0 {
					return base
				}
				return joinRoute(base, path)
			}
		}
		return base
	case *ast.Ident:
		object, ok := w.u.info.Uses[e].(*types.Var)
		if !ok || object.Pos() < w.file.ast.FileStart || object.Pos() >= w.file.ast.FileEnd {
			return ""
		}
		if value, assigned := w.assignments()[object]; assigned {
			if value == nil {
				return ""
			}
			return w.routerPrefix(value, depth+1)
		}
		// A parameter of a function literal registered under a path: that path is its prefix.
		position := w.x.offset(object.Pos())
		if span := w.routeOf(position, position); span != nil && span.prefix != "" {
			return span.prefix
		}
	}
	return ""
}

// assignments maps each local variable of the file to the one value it is assigned, or to nil
// when it is assigned more than once or without a single matching value.
func (w *walker) assignments() map[*types.Var]ast.Expr {
	if w.assigned != nil {
		return w.assigned
	}
	w.assigned = map[*types.Var]ast.Expr{}
	assign := func(name *ast.Ident, value ast.Expr, define bool) {
		object, _ := w.u.info.Defs[name].(*types.Var)
		if object == nil {
			object, _ = w.u.info.Uses[name].(*types.Var)
		}
		if object == nil {
			return
		}
		if _, seen := w.assigned[object]; seen || !define {
			value = nil
		}
		w.assigned[object] = value
	}
	ast.Inspect(w.file.ast, func(n ast.Node) bool {
		switch e := n.(type) {
		case *ast.AssignStmt:
			for i, lhs := range e.Lhs {
				name, ok := lhs.(*ast.Ident)
				if !ok || name.Name == "_" {
					continue
				}
				var value ast.Expr
				if len(e.Lhs) == len(e.Rhs) {
					value = e.Rhs[i]
				}
				assign(name, value, e.Tok == token.DEFINE && value != nil)
			}
		case *ast.ValueSpec:
			for i, name := range e.Names {
				var value ast.Expr
				if len(e.Names) == len(e.Values) {
					value = e.Values[i]
				}
				assign(name, value, value != nil)
			}
		}
		return true
	})
	return w.assigned
}

// joinRoute appends a path to the prefix it is registered under, with one slash between them.
func joinRoute(prefix, path string) string {
	if prefix == "" {
		return path
	}
	return strings.TrimRight(prefix, "/") + "/" + strings.TrimLeft(path, "/")
}

// routeLiteral registers a map entry's value under its path key, and a struct's other fields
// under the path one of its fields holds, as in Route{Pattern: "/load", Handler: handleLoad}.
func (w *walker) routeLiteral(lit *ast.CompositeLit) {
	kind := w.literalType(lit)
	_, structure := kind.(*types.Struct)
	_, mapping := kind.(*types.Map)
	path, found := "", false
	var fields []ast.Expr
	for _, element := range lit.Elts {
		if pair, ok := element.(*ast.KeyValueExpr); ok {
			if key, ok := w.pathConstant(pair.Key); ok {
				w.route(pair.Value, key, "")
				continue
			}
			// Field names key a struct literal even when its type is not loaded.
			if _, named := pair.Key.(*ast.Ident); !named || mapping {
				continue
			}
			structure, element = true, pair.Value
		} else if !structure {
			continue
		}
		if value, ok := w.pathConstant(element); ok && !found {
			path, found = value, true
			continue
		}
		fields = append(fields, element)
	}
	if !found {
		return
	}
	for _, field := range fields {
		w.route(field, path, "")
	}
}

func (w *walker) literalType(lit *ast.CompositeLit) types.Type {
	if tv, ok := w.u.info.Types[lit]; ok && validType(tv.Type) {
		return tv.Type.Underlying()
	}
	return nil
}

func (w *walker) route(expr ast.Expr, label, prefix string) {
	start, end := w.x.span(expr)
	w.routes = append(w.routes, routeSpan{start, end, label, prefix, w.executing[len(w.executing)-1]})
}

// routeOf is the innermost registered expression enclosing a site.
func (w *walker) routeOf(start, end int) *routeSpan {
	var best *routeSpan
	for i := range w.routes {
		span := &w.routes[i]
		if span.start <= start && end <= span.end &&
			(best == nil || span.end-span.start < best.end-best.start) {
			best = span
		}
	}
	return best
}

// callRoute is the path a project call serves: any call in a function literal registered under
// it, or a call made in the registration itself that may produce a handler, as api(repo) does.
// A call returning only plain values, such as makeEtag(key) returning a string, serves nothing.
func (w *walker) callRoute(fact relationFact, callee types.Object) string {
	if fact.To == 0 {
		return ""
	}
	span := w.routeOf(fact.Start, fact.End)
	if span == nil {
		return ""
	}
	if fact.From != span.owner {
		return span.label
	}
	if callee == nil {
		return ""
	}
	signature, ok := callee.Type().(*types.Signature)
	if !ok {
		return ""
	}
	for i := 0; i < signature.Results().Len(); i++ {
		basic, plain := signature.Results().At(i).Type().Underlying().(*types.Basic)
		// Types from unloaded packages, such as http.HandlerFunc, are invalid: they may be handlers.
		if !plain || basic.Kind() == types.Invalid {
			return span.label
		}
	}
	return ""
}
