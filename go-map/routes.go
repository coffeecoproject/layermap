package main

import (
	"go/ast"
	"go/constant"
	"go/token"
	"go/types"
	"regexp"
	"strconv"
)

// A path, optionally after a method, as route patterns are written: "/v1/users", "GET /v1/users".
var pathPattern = regexp.MustCompile(`^(?:[A-Z]+ +)?/`)

type routeSpan struct {
	start, end int
	path       string
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
	for i, argument := range call.Args {
		if path, ok := w.pathConstant(argument); ok {
			for _, registered := range call.Args[i+1:] {
				w.route(registered, path)
			}
			return
		}
	}
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
				w.route(pair.Value, key)
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
		w.route(field, path)
	}
}

func (w *walker) literalType(lit *ast.CompositeLit) types.Type {
	if tv, ok := w.u.info.Types[lit]; ok && validType(tv.Type) {
		return tv.Type.Underlying()
	}
	return nil
}

func (w *walker) route(expr ast.Expr, path string) {
	start, end := w.x.span(expr)
	w.routes = append(w.routes, routeSpan{start, end, path, w.executing[len(w.executing)-1]})
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
		return span.path
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
			return span.path
		}
	}
	return ""
}
