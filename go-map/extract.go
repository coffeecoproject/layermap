package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"strconv"
)

type fileFact struct {
	Path     string `json:"path"`
	Object   int    `json:"object,omitempty"`
	Excluded string `json:"excluded,omitempty"`
}

type objectFact struct {
	ID        int    `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	NameStart int    `json:"nameStart"`
	Parent    int    `json:"parent,omitempty"`
	Exported  bool   `json:"exported"`
	Execution string `json:"execution,omitempty"`
}

type relationFact struct {
	Kind   string `json:"kind"`
	From   int    `json:"from"`
	To     int    `json:"to,omitempty"`
	Path   string `json:"path"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
	Target string `json:"target"`
	Basis  string `json:"basis"`
	Reason string `json:"reason,omitempty"`
	// The route a call or value is registered under: its methods, if named, then its path.
	Argument string `json:"argument,omitempty"`
}

type noteFact struct {
	Object int    `json:"object"`
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Start  int    `json:"start"`
	End    int    `json:"end"`
}

type buildOutput struct {
	Files      []fileFact     `json:"files"`
	Objects    []objectFact   `json:"objects"`
	Relations  []relationFact `json:"relations"`
	Notes      []noteFact     `json:"notes"`
	TypeErrors int            `json:"typeErrors"`
}

type posKey struct {
	path   string
	offset int
}

type sourceRef struct {
	u    *unit
	expr ast.Expr
	// Whether the variable receives the expression's value itself, not a second result such as
	// the ok of a type assertion.
	value bool
}

type extractor struct {
	p       *program
	out     *buildOutput
	byName  map[posKey]int // declared objects by the offset of their name
	objects map[int]*objectFact
	perFile map[string][]int
	closure map[*ast.FuncLit]int
	// The unit whose type information describes each file's bodies.
	unitOf map[*sourceFile]*unit
	// Where a variable's type comes from, to tell library values from unknown ones.
	varSource map[types.Object]sourceRef
	// Implementation links already emitted, as (from, to) object pairs.
	links map[[2]int]bool
	// Expressions that a call invokes, which are not value uses.
	callees map[ast.Expr]bool
	// Declared types by package directory, test variant and name.
	types map[typeKey]int
	// Written signatures of methods and interface methods, by the offset of their name.
	signatures map[posKey]signatureSource
}

type typeKey struct {
	dir      string
	external bool
	name     string
}

func extract(p *program) buildOutput {
	x := &extractor{
		p: p,
		out: &buildOutput{
			Files: []fileFact{}, Objects: []objectFact{}, Relations: []relationFact{}, Notes: []noteFact{},
			TypeErrors: p.errors,
		},
		byName:     map[posKey]int{},
		objects:    map[int]*objectFact{},
		perFile:    map[string][]int{},
		closure:    map[*ast.FuncLit]int{},
		unitOf:     map[*sourceFile]*unit{},
		varSource:  map[types.Object]sourceRef{},
		links:      map[[2]int]bool{},
		callees:    map[ast.Expr]bool{},
		signatures: map[posKey]signatureSource{},
	}
	for _, u := range p.units {
		for _, file := range u.files {
			// Base files are described by the base unit; the tested unit adds only test files.
			if _, seen := x.unitOf[file]; !seen {
				x.unitOf[file] = u
			}
		}
	}
	for _, file := range p.files {
		fact := fileFact{Path: file.path, Excluded: file.excluded}
		if file.ast != nil {
			fact.Object = x.add(objectFact{
				Kind: "FILE", Name: file.path, Path: file.path, Start: 0, End: len(file.text),
				NameStart: -1, Execution: "MODULE",
			})
		}
		x.out.Files = append(x.out.Files, fact)
	}
	for i, file := range p.files {
		if file.ast != nil {
			x.declare(file, x.out.Files[i].Object)
		}
	}
	for _, file := range p.files {
		if file.ast != nil {
			x.attachMethods(file)
		}
	}
	for _, file := range p.files {
		if u := x.unitOf[file]; file.ast != nil && u != nil && u.info != nil {
			x.recordSources(file, u)
		}
	}
	for i, file := range p.files {
		if u := x.unitOf[file]; file.ast != nil && u != nil && u.info != nil {
			x.relate(file, u, x.out.Files[i].Object)
		}
	}
	x.implementations()
	return *x.out
}

func (x *extractor) add(fact objectFact) int {
	fact.ID = len(x.out.Objects) + 1
	x.out.Objects = append(x.out.Objects, fact)
	x.perFile[fact.Path] = append(x.perFile[fact.Path], fact.ID)
	if fact.NameStart >= 0 {
		x.byName[posKey{fact.Path, fact.NameStart}] = fact.ID
	}
	return fact.ID
}

func (x *extractor) object(id int) *objectFact {
	return &x.out.Objects[id-1]
}

func (x *extractor) offset(pos token.Pos) int {
	return x.p.fset.Position(pos).Offset
}

func (x *extractor) span(node ast.Node) (int, int) {
	return x.offset(node.Pos()), x.offset(node.End())
}

func (x *extractor) doc(object int, group *ast.CommentGroup, path string) {
	if group == nil {
		return
	}
	start, end := x.span(group)
	x.out.Notes = append(x.out.Notes, noteFact{Object: object, Kind: "SOURCE_DOCUMENTATION", Path: path, Start: start, End: end})
}

// declare adds the file's package-level declarations and the members of its types.
func (x *extractor) declare(file *sourceFile, fileObject int) {
	for _, decl := range file.ast.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			start, end := x.span(d)
			kind := "FUNCTION"
			if d.Recv != nil {
				kind = "METHOD"
			}
			// A function declared without a body (implemented in assembly) runs nothing here.
			execution := "FUNCTION"
			if d.Body == nil {
				execution = ""
			}
			id := x.add(objectFact{
				Kind: kind, Name: d.Name.Name, Path: file.path, Start: start, End: end,
				NameStart: x.offset(d.Name.Pos()), Parent: fileObject,
				Exported: token.IsExported(d.Name.Name), Execution: execution,
			})
			x.signatures[posKey{file.path, x.offset(d.Name.Pos())}] = signatureSource{file, d.Type}
			x.doc(id, d.Doc, file.path)
		case *ast.GenDecl:
			single := len(d.Specs) == 1 && !d.Lparen.IsValid()
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					var node ast.Node = s
					if single {
						node = d
					}
					start, end := x.span(node)
					kind := "TYPE"
					switch s.Type.(type) {
					case *ast.StructType:
						kind = "CLASS"
					case *ast.InterfaceType:
						kind = "INTERFACE"
					}
					id := x.add(objectFact{
						Kind: kind, Name: s.Name.Name, Path: file.path, Start: start, End: end,
						NameStart: x.offset(s.Name.Pos()), Parent: fileObject,
						Exported: token.IsExported(s.Name.Name),
					})
					if s.Doc != nil {
						x.doc(id, s.Doc, file.path)
					} else if single {
						x.doc(id, d.Doc, file.path)
					}
					x.members(file, id, s.Type)
				case *ast.ValueSpec:
					for i, name := range s.Names {
						if name.Name == "_" {
							continue
						}
						var node ast.Node = name
						if len(s.Names) == 1 {
							node = s
						}
						start, end := x.span(node)
						execution := ""
						if len(s.Names) == 1 && len(s.Values) == 1 {
							if _, ok := unparen(s.Values[0]).(*ast.FuncLit); ok {
								execution = "CLOSURE"
							}
						}
						id := x.add(objectFact{
							Kind: "VARIABLE", Name: name.Name, Path: file.path, Start: start, End: end,
							NameStart: x.offset(name.Pos()), Parent: fileObject,
							Exported: token.IsExported(name.Name), Execution: execution,
						})
						if execution == "CLOSURE" {
							x.closure[unparen(s.Values[i]).(*ast.FuncLit)] = id
						}
						if s.Doc != nil {
							x.doc(id, s.Doc, file.path)
						} else if single {
							x.doc(id, d.Doc, file.path)
						}
					}
				}
			}
		}
	}
}

// members adds struct fields and interface methods; embedded types become EXTENDS later.
func (x *extractor) members(file *sourceFile, owner int, expr ast.Expr) {
	var fields *ast.FieldList
	interfaceType := false
	switch t := expr.(type) {
	case *ast.StructType:
		fields = t.Fields
	case *ast.InterfaceType:
		fields = t.Methods
		interfaceType = true
	}
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		for _, name := range field.Names {
			var node ast.Node = name
			if len(field.Names) == 1 {
				node = field
			}
			start, end := x.span(node)
			kind := "PROPERTY"
			if signature, method := field.Type.(*ast.FuncType); method && interfaceType {
				kind = "METHOD"
				x.signatures[posKey{file.path, x.offset(name.Pos())}] = signatureSource{file, signature}
			}
			id := x.add(objectFact{
				Kind: kind, Name: name.Name, Path: file.path, Start: start, End: end,
				NameStart: x.offset(name.Pos()), Parent: owner, Exported: token.IsExported(name.Name),
			})
			x.doc(id, field.Doc, file.path)
		}
	}
}

// attachMethods moves each method under its receiver type, which may be declared in another
// file of the same package.
func (x *extractor) attachMethods(file *sourceFile) {
	dir := dirOf(file.path)
	for _, decl := range file.ast.Decls {
		d, ok := decl.(*ast.FuncDecl)
		if !ok || d.Recv == nil || len(d.Recv.List) == 0 {
			continue
		}
		name := receiverName(d.Recv.List[0].Type)
		if name == "" {
			continue
		}
		method := x.byName[posKey{file.path, x.offset(d.Name.Pos())}]
		if owner := x.typeInDir(dir, name, file.external); owner != 0 && method != 0 {
			x.object(method).Parent = owner
		}
	}
}

func receiverName(expr ast.Expr) string {
	for {
		switch t := expr.(type) {
		case *ast.StarExpr:
			expr = t.X
		case *ast.ParenExpr:
			expr = t.X
		case *ast.IndexExpr:
			expr = t.X
		case *ast.IndexListExpr:
			expr = t.X
		case *ast.Ident:
			return t.Name
		default:
			return ""
		}
	}
}

func dirOf(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return "."
}

// typeInDir finds a type declared in the same package as the method.
func (x *extractor) typeInDir(dir, name string, external bool) int {
	if x.types == nil {
		x.types = map[typeKey]int{}
		for _, file := range x.p.files {
			if file.ast == nil {
				continue
			}
			for _, decl := range file.ast.Decls {
				d, ok := decl.(*ast.GenDecl)
				if !ok || d.Tok != token.TYPE {
					continue
				}
				for _, spec := range d.Specs {
					s := spec.(*ast.TypeSpec)
					key := typeKey{dirOf(file.path), file.external, s.Name.Name}
					if _, seen := x.types[key]; !seen {
						x.types[key] = x.byName[posKey{file.path, x.offset(s.Name.Pos())}]
					}
				}
			}
		}
	}
	return x.types[typeKey{dir, external, name}]
}

// recordSources notes where each variable's value or type comes from.
func (x *extractor) recordSources(file *sourceFile, u *unit) {
	define := func(ident *ast.Ident, expr ast.Expr, value bool) {
		if ident == nil || expr == nil {
			return
		}
		if obj := u.info.Defs[ident]; obj != nil {
			if _, seen := x.varSource[obj]; !seen {
				x.varSource[obj] = sourceRef{u, expr, value}
			}
		}
	}
	ast.Inspect(file.ast, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.Field:
			for _, name := range n.Names {
				define(name, n.Type, false)
			}
		case *ast.ValueSpec:
			for i, name := range n.Names {
				switch {
				case n.Type != nil:
					define(name, n.Type, false)
				case len(n.Values) == len(n.Names):
					define(name, n.Values[i], true)
				case len(n.Values) == 1:
					define(name, n.Values[0], i == 0)
				}
			}
		case *ast.AssignStmt:
			if n.Tok != token.DEFINE {
				return true
			}
			for i, lhs := range n.Lhs {
				ident, _ := lhs.(*ast.Ident)
				switch {
				case len(n.Rhs) == len(n.Lhs):
					define(ident, n.Rhs[i], true)
				case len(n.Rhs) == 1:
					define(ident, n.Rhs[0], i == 0)
				}
			}
		case *ast.RangeStmt:
			if n.Tok == token.DEFINE {
				key, _ := n.Key.(*ast.Ident)
				value, _ := n.Value.(*ast.Ident)
				define(key, n.X, false)
				define(value, n.X, false)
			}
		}
		return true
	})
}

// origin tells whether an expression's value comes from the standard library or another module.
func (x *extractor) origin(u *unit, expr ast.Expr, depth int) string {
	if depth > 12 || expr == nil {
		return ""
	}
	switch e := unparen(expr).(type) {
	case *ast.Ident:
		obj := u.info.Uses[e]
		if obj == nil {
			obj = u.info.Defs[e]
		}
		switch o := obj.(type) {
		case *types.PkgName:
			return x.packageReason(o.Imported())
		case *types.Var:
			if source, ok := x.varSource[o]; ok {
				return x.origin(source.u, source.expr, depth+1)
			}
		}
	case *ast.SelectorExpr:
		if ident, ok := e.X.(*ast.Ident); ok {
			if name, ok := u.info.Uses[ident].(*types.PkgName); ok {
				return x.packageReason(name.Imported())
			}
		}
		return x.origin(u, e.X, depth+1)
	case *ast.CallExpr:
		return x.origin(u, e.Fun, depth+1)
	case *ast.IndexExpr:
		return x.origin(u, e.X, depth+1)
	case *ast.IndexListExpr:
		return x.origin(u, e.X, depth+1)
	case *ast.StarExpr:
		return x.origin(u, e.X, depth+1)
	case *ast.UnaryExpr:
		return x.origin(u, e.X, depth+1)
	case *ast.TypeAssertExpr:
		if e.Type != nil {
			return x.origin(u, e.Type, depth+1)
		}
		return x.origin(u, e.X, depth+1)
	case *ast.ArrayType:
		return x.origin(u, e.Elt, depth+1)
	case *ast.MapType:
		return x.origin(u, e.Value, depth+1)
	case *ast.ChanType:
		return x.origin(u, e.Value, depth+1)
	case *ast.CompositeLit:
		return x.origin(u, e.Type, depth+1)
	}
	return ""
}

func (x *extractor) packageReason(pkg *types.Package) string {
	if pkg == nil || x.p.placehold[pkg.Path()] != pkg {
		return ""
	}
	if isStandard(pkg.Path()) {
		return "COMPILER_LIBRARY"
	}
	return "DECLARATION_NOT_AVAILABLE"
}

// objectID maps a type-checker object to its map object, adding locals that are linked.
func (x *extractor) objectID(obj types.Object) (int, string) {
	switch o := obj.(type) {
	case *types.Func:
		obj = o.Origin()
	case *types.Var:
		obj = o.Origin()
	}
	if obj.Pkg() != nil && x.p.placehold[obj.Pkg().Path()] == obj.Pkg() {
		return 0, x.packageReason(obj.Pkg())
	}
	if !obj.Pos().IsValid() {
		// Universe members such as error.Error.
		return 0, "COMPILER_LIBRARY"
	}
	position := x.p.fset.Position(obj.Pos())
	file := x.p.byPath[position.Filename]
	if file == nil {
		return 0, "OUTSIDE_SOURCE_CONTEXT"
	}
	if id := x.byName[posKey{file.path, position.Offset}]; id != 0 {
		return id, ""
	}
	kind := ""
	switch v := obj.(type) {
	case *types.Var:
		kind = "VARIABLE"
		if v.IsField() {
			kind = "PROPERTY"
		}
	case *types.Func:
		// A method of an interface written in place, such as interface{ Addr() net.Addr }.
		kind = "METHOD"
	default:
		return 0, "SOURCE_DECLARATION_UNMAPPED"
	}
	start := position.Offset
	id := x.add(objectFact{
		Kind: kind, Name: obj.Name(), Path: file.path, Start: start, End: start + len(obj.Name()),
		NameStart: start, Parent: x.innermost(file.path, start, start+len(obj.Name())),
	})
	return id, ""
}

// declaredID finds an already declared object without adding linked locals.
func (x *extractor) declaredID(obj types.Object) int {
	if v, ok := obj.(*types.Var); ok {
		obj = v.Origin()
	}
	if !obj.Pos().IsValid() {
		return 0
	}
	position := x.p.fset.Position(obj.Pos())
	return x.byName[posKey{position.Filename, position.Offset}]
}

// innermost finds the smallest declared object that encloses a span.
func (x *extractor) innermost(path string, start, end int) int {
	best := 0
	for _, id := range x.perFile[path] {
		o := x.object(id)
		if o.Start <= start && end <= o.End && !(o.Start == start && o.End == end) {
			if best == 0 || o.End-o.Start < x.object(best).End-x.object(best).Start {
				best = id
			}
		}
	}
	return best
}

func unparen(expr ast.Expr) ast.Expr {
	for {
		p, ok := expr.(*ast.ParenExpr)
		if !ok {
			return expr
		}
		expr = p.X
	}
}

// label names an expression the way the rest of the map does.
func label(u *unit, expr ast.Expr) string {
	switch e := unparen(expr).(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return label(u, e.X) + "." + e.Sel.Name
	case *ast.IndexExpr:
		if tv, ok := u.info.Types[e.Index]; ok && tv.IsType() {
			return label(u, e.X)
		}
		return label(u, e.X) + "[…]"
	case *ast.IndexListExpr:
		return label(u, e.X)
	case *ast.StarExpr:
		return label(u, e.X)
	case *ast.CallExpr:
		return "<CallExpression>"
	case *ast.FuncLit:
		return "<FunctionExpression>"
	case *ast.CompositeLit:
		return "<CompositeLiteral>"
	case *ast.TypeAssertExpr:
		return "<TypeAssertion>"
	default:
		return "<Expression>"
	}
}

type walker struct {
	x    *extractor
	u    *unit
	file *sourceFile
	// Executing object and innermost declared object for the current node.
	executing []int
	declared  []int
	// Expressions registered under a path constant in this file.
	routes []routeSpan
	// HTTP methods chained onto a registration call, recorded before the call is visited.
	methods map[*ast.CallExpr][]string
	// Each local variable's single assigned value (nil when assigned otherwise), built on demand.
	assigned map[*types.Var]ast.Expr
}

func (x *extractor) relate(file *sourceFile, u *unit, fileObject int) {
	w := &walker{x: x, u: u, file: file, executing: []int{fileObject}, declared: []int{fileObject}, methods: map[*ast.CallExpr][]string{}}
	for _, spec := range file.ast.Imports {
		w.importSpec(spec, fileObject)
	}
	for _, decl := range file.ast.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			id := x.byName[posKey{file.path, x.offset(d.Name.Pos())}]
			if id == 0 {
				continue
			}
			w.push(id, id)
			if d.Recv != nil {
				w.walk(d.Recv)
			}
			w.walk(d.Type)
			if d.Body != nil {
				w.walk(d.Body)
			}
			w.pop()
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					id := x.byName[posKey{file.path, x.offset(s.Name.Pos())}]
					w.embedded(id, s.Type)
				case *ast.ValueSpec:
					for i, name := range s.Names {
						id := x.byName[posKey{file.path, x.offset(name.Pos())}]
						// A blank name declares nothing, but its value still runs with the file
						// (var _ = Register(...), a test suite's var _ = Describe(...)).
						if id == 0 && name.Name != "_" {
							continue
						}
						if id != 0 {
							w.declared = append(w.declared, id)
						}
						if i < len(s.Values) && len(s.Values) == len(s.Names) {
							w.walk(s.Values[i])
						} else if i == 0 {
							for _, value := range s.Values {
								w.walk(value)
							}
						}
						if id != 0 {
							w.declared = w.declared[:len(w.declared)-1]
						}
					}
				}
			}
		}
	}
}

func (w *walker) push(executing, declared int) {
	w.executing = append(w.executing, executing)
	w.declared = append(w.declared, declared)
}

func (w *walker) pop() {
	w.executing = w.executing[:len(w.executing)-1]
	w.declared = w.declared[:len(w.declared)-1]
}

func (w *walker) relation(fact relationFact) {
	if fact.Kind == "REFERENCES" {
		if span := w.routeOf(fact.Start, fact.End); span != nil {
			fact.Argument = span.label
		}
	}
	w.x.out.Relations = append(w.x.out.Relations, fact)
}

func (w *walker) importSpec(spec *ast.ImportSpec, fileObject int) {
	importPath, err := strconv.Unquote(spec.Path.Value)
	if err != nil || importPath == "C" {
		return
	}
	start, end := w.x.span(spec)
	kind := "IMPORTS"
	if w.file.test {
		kind = "TEST_IMPORTS"
	}
	fact := relationFact{Kind: kind, From: fileObject, Path: w.file.path, Start: start, End: end, Target: importPath}
	if target := w.x.representative(importPath); target != 0 {
		fact.To, fact.Basis = target, "TYPE_RESOLVED"
	} else {
		fact.Basis = "UNRESOLVED"
		fact.Reason = "DECLARATION_NOT_AVAILABLE"
		if isStandard(importPath) {
			fact.Reason = "COMPILER_LIBRARY"
		}
	}
	w.relation(fact)
}

// representative is the file object an import of a package points to: its first non-test file.
func (x *extractor) representative(importPath string) int {
	u, ok := x.p.base[importPath]
	if !ok {
		return 0
	}
	files := u.files
	if len(files) == 0 {
		if tested, ok := x.p.tested[u.dir]; ok {
			files = tested.files
		}
	}
	best := ""
	for _, file := range files {
		if best == "" || file.path < best {
			best = file.path
		}
	}
	for i, file := range x.p.files {
		if file.path == best {
			return x.out.Files[i].Object
		}
	}
	return 0
}

// embedded relates a struct or interface to the types it embeds.
func (w *walker) embedded(owner int, expr ast.Expr) {
	var fields *ast.FieldList
	switch t := expr.(type) {
	case *ast.StructType:
		fields = t.Fields
	case *ast.InterfaceType:
		fields = t.Methods
	}
	if fields == nil || owner == 0 {
		return
	}
	for _, field := range fields.List {
		if len(field.Names) > 0 {
			continue
		}
		if _, method := field.Type.(*ast.FuncType); method {
			continue
		}
		typeExpr := field.Type
		for {
			if star, ok := typeExpr.(*ast.StarExpr); ok {
				typeExpr = star.X
				continue
			}
			if index, ok := typeExpr.(*ast.IndexExpr); ok {
				typeExpr = index.X
				continue
			}
			if index, ok := typeExpr.(*ast.IndexListExpr); ok {
				typeExpr = index.X
				continue
			}
			break
		}
		var ident *ast.Ident
		switch t := typeExpr.(type) {
		case *ast.Ident:
			ident = t
		case *ast.SelectorExpr:
			ident = t.Sel
		default:
			continue
		}
		start, end := w.x.span(field)
		fact := relationFact{Kind: "EXTENDS", From: owner, Path: w.file.path, Start: start, End: end, Target: label(w.u, typeExpr)}
		w.resolveInto(&fact, w.u.info.Uses[ident], typeExpr)
		w.relation(fact)
	}
}

// resolveInto sets the target or the reason it stays unresolved.
func (w *walker) resolveInto(fact *relationFact, obj types.Object, expr ast.Expr) {
	if obj != nil {
		if id, reason := w.x.objectID(obj); id != 0 {
			fact.To, fact.Basis = id, "TYPE_RESOLVED"
			return
		} else if reason != "" {
			fact.Basis, fact.Reason = "UNRESOLVED", reason
			return
		}
	}
	fact.Basis = "UNRESOLVED"
	fact.Reason = w.x.origin(w.u, expr, 0)
	if fact.Reason == "" {
		fact.Reason = "SYMBOL_NOT_RESOLVED"
	}
}

func (w *walker) walk(node ast.Node) {
	if node == nil {
		return
	}
	ast.Inspect(node, func(n ast.Node) bool {
		switch e := n.(type) {
		case *ast.FuncLit:
			w.funcLit(e)
			return false
		case *ast.CallExpr:
			w.routeCall(e)
			w.call(e)
		case *ast.CompositeLit:
			w.routeLiteral(e)
		case *ast.AssignStmt:
			if e.Tok != token.DEFINE {
				for _, lhs := range e.Lhs {
					w.write(lhs)
				}
			}
			w.carriers(e)
		case *ast.IncDecStmt:
			w.write(e.X)
		case *ast.Ident:
			w.valueUse(e, e)
		case *ast.SelectorExpr:
			w.valueUse(e.Sel, e)
			ast.Inspect(e.X, func(inner ast.Node) bool { return w.visitInner(inner) })
			return false
		}
		return true
	})
}

// visitInner walks a selector's receiver with the same rules.
func (w *walker) visitInner(n ast.Node) bool {
	switch e := n.(type) {
	case *ast.FuncLit:
		w.funcLit(e)
		return false
	case *ast.CallExpr:
		w.routeCall(e)
		w.call(e)
	case *ast.CompositeLit:
		w.routeLiteral(e)
	case *ast.Ident:
		w.valueUse(e, e)
	case *ast.SelectorExpr:
		w.valueUse(e.Sel, e)
		ast.Inspect(e.X, func(inner ast.Node) bool { return w.visitInner(inner) })
		return false
	}
	return true
}

// carriers gives a function literal assigned to one new local variable that variable's identity.
func (w *walker) carriers(assign *ast.AssignStmt) {
	if assign.Tok != token.DEFINE || len(assign.Lhs) != 1 || len(assign.Rhs) != 1 {
		return
	}
	ident, ok := assign.Lhs[0].(*ast.Ident)
	lit, isLit := unparen(assign.Rhs[0]).(*ast.FuncLit)
	if !ok || !isLit || ident.Name == "_" {
		return
	}
	if _, done := w.x.closure[lit]; done {
		return
	}
	start := w.x.offset(ident.Pos())
	_, end := w.x.span(assign)
	id := w.x.add(objectFact{
		Kind: "VARIABLE", Name: ident.Name, Path: w.file.path, Start: start, End: end,
		NameStart: start, Parent: w.declared[len(w.declared)-1], Execution: "CLOSURE",
	})
	w.x.closure[lit] = id
}

// closureOf is a function literal's executable identity: the variable it initializes, or an
// anonymous function owned by the enclosing declaration.
func (w *walker) closureOf(lit *ast.FuncLit) int {
	id, ok := w.x.closure[lit]
	if !ok {
		start, end := w.x.span(lit)
		id = w.x.add(objectFact{
			Kind: "FUNCTION", Name: "<anonymous function>", Path: w.file.path, Start: start, End: end,
			NameStart: -1, Parent: w.declared[len(w.declared)-1], Execution: "CLOSURE",
		})
		w.x.closure[lit] = id
	}
	return id
}

func (w *walker) funcLit(lit *ast.FuncLit) {
	id := w.closureOf(lit)
	w.push(id, id)
	w.walk(lit.Type)
	w.walk(lit.Body)
	w.pop()
}

func (w *walker) call(call *ast.CallExpr) {
	w.x.callees[call.Fun] = true
	fun := unparen(call.Fun)
	w.x.callees[fun] = true
	if index, ok := fun.(*ast.IndexExpr); ok {
		if tv, ok := w.u.info.Types[index.Index]; ok && tv.IsType() {
			fun = index.X
		}
	} else if index, ok := fun.(*ast.IndexListExpr); ok {
		fun = index.X
	}
	w.x.callees[fun] = true
	start, end := w.x.span(call)
	fact := relationFact{Kind: "CALLS", From: w.executing[len(w.executing)-1], Path: w.file.path, Start: start, End: end, Target: label(w.u, fun)}
	var obj types.Object
	switch f := fun.(type) {
	case *ast.FuncLit:
		fact.To, fact.Basis, fact.Target = w.closureOf(f), "SYNTAX_DECLARED", "<FunctionExpression>"
		w.relation(fact)
		return
	case *ast.Ident:
		obj = w.u.info.Uses[f]
	case *ast.SelectorExpr:
		obj = w.member(f, 0)
		if obj == nil {
			// A method of an interface written in a type assertion, whose operand's type is unknown.
			if name := w.inlineMethod(f.X, f.Sel.Name, 0); name != nil {
				fact.To, fact.Basis = w.x.declaredAt(w.file, name, "METHOD"), "SYNTAX_DECLARED"
				fact.Argument = w.callRoute(fact, nil)
				w.relation(fact)
				return
			}
		}
	}
	switch obj.(type) {
	case *types.TypeName, *types.Builtin, *types.Nil:
		// Conversions and built-ins execute no project code.
		return
	}
	if obj == nil {
		if tv, ok := w.u.info.Types[fun]; ok && tv.IsType() {
			return
		}
	}
	w.resolveInto(&fact, obj, fun)
	fact.Argument = w.callRoute(fact, obj)
	w.relation(fact)
}

// valueUse links a function used as a value (stored, passed or returned), or a package-level
// variable or constant that is read, to its user: a change to either changes what the user does.
func (w *walker) valueUse(ident *ast.Ident, expr ast.Expr) {
	obj := w.u.info.Uses[ident]
	if obj == nil || w.isCallee(expr) {
		return
	}
	id := 0
	switch v := obj.(type) {
	case *types.Func:
		id, _ = w.x.objectID(obj)
	case *types.Var:
		// A local is mapped only when it holds a function literal; package-level state always is.
		id = w.x.declaredID(obj)
		if id != 0 && w.x.object(id).Execution != "CLOSURE" && (v.Pkg() == nil || v.Parent() != v.Pkg().Scope()) {
			id = 0
		}
	case *types.Const:
		if v.Pkg() != nil && v.Parent() == v.Pkg().Scope() {
			id = w.x.declaredID(obj)
		}
	}
	if id == 0 {
		return
	}
	start, end := w.x.span(expr)
	w.relation(relationFact{
		Kind: "REFERENCES", From: w.declared[len(w.declared)-1], To: id, Path: w.file.path,
		Start: start, End: end, Target: ident.Name, Basis: "TYPE_RESOLVED",
	})
}

// isCallee reports whether the expression is what a call invokes.
func (w *walker) isCallee(expr ast.Expr) bool {
	return w.x.callees[expr]
}

func (w *walker) write(target ast.Expr) {
	target = unparen(target)
	base := target
	for {
		if index, ok := base.(*ast.IndexExpr); ok {
			base = unparen(index.X)
			continue
		}
		break
	}
	var obj types.Object
	switch t := base.(type) {
	case *ast.Ident:
		obj = w.u.info.Uses[t]
		v, ok := obj.(*types.Var)
		if !ok || v.Pkg() == nil || v.Parent() != v.Pkg().Scope() {
			// Only package-level variables are shared state; locals are not tracked.
			return
		}
	case *ast.SelectorExpr:
		if selection := w.u.info.Selections[t]; selection != nil {
			obj = selection.Obj()
		} else {
			obj = w.u.info.Uses[t.Sel]
		}
	default:
		return
	}
	start, end := w.x.span(target)
	fact := relationFact{Kind: "WRITES", From: w.executing[len(w.executing)-1], Path: w.file.path, Start: start, End: end, Target: label(w.u, target)}
	w.resolveInto(&fact, obj, base)
	w.relation(fact)
}

func validType(t types.Type) bool {
	return t != nil && !invalidIn(t, 0)
}

// member resolves X.Sel. When X is invalid only because a value came from an unloaded package,
// a type written in the source (a type assertion) still decides the member.
func (w *walker) member(sel *ast.SelectorExpr, depth int) types.Object {
	if selection := w.u.info.Selections[sel]; selection != nil {
		return selection.Obj()
	}
	if obj := w.u.info.Uses[sel.Sel]; obj != nil {
		return obj
	}
	if depth > 8 {
		return nil
	}
	t := w.recovered(sel.X, depth+1)
	if t == nil {
		return nil
	}
	obj, _, _ := types.LookupFieldOrMethod(t, true, w.u.pkg, sel.Sel.Name)
	return obj
}

// recovered is an expression's type, recovered through written type assertions when the checker
// left it invalid.
func (w *walker) recovered(expr ast.Expr, depth int) types.Type {
	if depth > 8 || expr == nil {
		return nil
	}
	if tv, ok := w.u.info.Types[expr]; ok && validType(tv.Type) {
		return tv.Type
	}
	switch e := unparen(expr).(type) {
	case *ast.TypeAssertExpr:
		if e.Type == nil {
			return nil
		}
		if tv, ok := w.u.info.Types[e.Type]; ok && tv.IsType() && validType(tv.Type) {
			return tv.Type
		}
		return w.writtenType(e.Type)
	case *ast.Ident:
		if v, ok := w.u.info.Uses[e].(*types.Var); ok {
			if validType(v.Type()) {
				return v.Type()
			}
			if source, ok := w.x.varSource[v]; ok && source.value && source.u == w.u {
				return w.recovered(source.expr, depth+1)
			}
		}
	case *ast.StarExpr:
		if t := w.recovered(e.X, depth+1); t != nil {
			if pointer, ok := t.Underlying().(*types.Pointer); ok {
				return pointer.Elem()
			}
		}
	case *ast.SelectorExpr:
		if v, ok := w.member(e, depth+1).(*types.Var); ok && validType(v.Type()) {
			return v.Type()
		}
	case *ast.IndexExpr:
		if t := w.recovered(e.X, depth+1); t != nil {
			switch container := t.Underlying().(type) {
			case *types.Map:
				return container.Elem()
			case *types.Slice:
				return container.Elem()
			case *types.Array:
				return container.Elem()
			}
		}
	case *ast.CallExpr:
		// A conversion spells its result type.
		if t := w.writtenType(e.Fun); t != nil {
			return t
		}
		if sel, ok := unparen(e.Fun).(*ast.SelectorExpr); ok {
			if f, ok := w.member(sel, depth+1).(*types.Func); ok {
				if signature, ok := f.Type().(*types.Signature); ok && signature.Results().Len() == 1 {
					if result := signature.Results().At(0).Type(); validType(result) {
						return result
					}
				}
			}
		}
	}
	return nil
}

// writtenType is the type a type expression spells, checked in place when the checker skipped it
// (it does once an operand is invalid). Errors from unloaded packages inside it are expected.
func (w *walker) writtenType(expr ast.Expr) types.Type {
	if tv, ok := w.u.info.Types[expr]; ok {
		if tv.IsType() && validType(tv.Type) {
			return tv.Type
		}
		return nil
	}
	if w.u.pkg == nil {
		return nil
	}
	info := &types.Info{Types: map[ast.Expr]types.TypeAndValue{}}
	_ = types.CheckExpr(w.x.p.fset, w.u.pkg, expr.Pos(), expr, info)
	if tv, ok := info.Types[expr]; ok && tv.IsType() && validType(tv.Type) {
		return tv.Type
	}
	return nil
}

// inlineMethod finds the method an interface literal in a type assertion declares, following
// variables assigned from the assertion.
func (w *walker) inlineMethod(expr ast.Expr, name string, depth int) *ast.Ident {
	if depth > 8 {
		return nil
	}
	switch e := unparen(expr).(type) {
	case *ast.TypeAssertExpr:
		if literal, ok := e.Type.(*ast.InterfaceType); ok && literal.Methods != nil {
			for _, field := range literal.Methods.List {
				for _, method := range field.Names {
					if method.Name == name {
						return method
					}
				}
			}
		}
	case *ast.Ident:
		if v, ok := w.u.info.Uses[e].(*types.Var); ok {
			if source, ok := w.x.varSource[v]; ok && source.value && source.u == w.u {
				return w.inlineMethod(source.expr, name, depth+1)
			}
		}
	}
	return nil
}

// declaredAt finds or adds the object a name in this file declares.
func (x *extractor) declaredAt(file *sourceFile, name *ast.Ident, kind string) int {
	start := x.offset(name.Pos())
	if id := x.byName[posKey{file.path, start}]; id != 0 {
		return id
	}
	return x.add(objectFact{
		Kind: kind, Name: name.Name, Path: file.path, Start: start, End: start + len(name.Name),
		NameStart: start, Parent: x.innermost(file.path, start, start+len(name.Name)),
	})
}
