package main

import (
	"go/ast"
	"go/token"
	"go/types"
	"strings"
)

type declaredType struct {
	id    int
	name  *types.TypeName
	ident *ast.Ident
	file  *sourceFile
}

// implementations links named types to the project interfaces they satisfy, and their methods to
// the interface methods, so calls through an interface can reach the implementations. Go types
// implement interfaces implicitly, so the type checker decides; generic types are left out.
func (x *extractor) implementations() {
	// Interfaces declared in base packages are visible to every unit that can import them.
	var shared []declaredType
	for _, u := range x.p.units {
		if u != x.p.base[u.importPath] || u.info == nil {
			continue
		}
		for _, d := range x.declaredTypes(u, u.files) {
			if isInterface(d.name) {
				shared = append(shared, d)
			}
		}
	}
	for _, u := range x.p.units {
		if u.info == nil {
			continue
		}
		// The files this unit describes: all of a base unit, only the test files of the others.
		var own []*sourceFile
		for _, file := range u.files {
			if x.unitOf[file] == u {
				own = append(own, file)
			}
		}
		interfaces := append([]declaredType{}, x.declaredTypes(u, u.files)...)
		for _, d := range shared {
			if dirOf(d.file.path) != u.dir {
				interfaces = append(interfaces, d)
			}
		}
		var candidates []declaredType
		for _, d := range interfaces {
			if isInterface(d.name) {
				candidates = append(candidates, d)
			}
		}
		for _, concrete := range x.declaredTypes(u, own) {
			named, ok := concrete.name.Type().(*types.Named)
			if !ok || isInterface(concrete.name) || named.TypeParams().Len() > 0 {
				continue
			}
			methods := types.NewMethodSet(types.NewPointer(named))
			if methods.Len() == 0 {
				continue
			}
			for _, iface := range candidates {
				x.implement(concrete, named, methods, iface)
			}
		}
	}
}

func isInterface(name *types.TypeName) bool {
	_, ok := name.Type().Underlying().(*types.Interface)
	return ok && !name.IsAlias()
}

func (x *extractor) declaredTypes(u *unit, files []*sourceFile) []declaredType {
	var result []declaredType
	for _, file := range files {
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
				name, ok := u.info.Defs[s.Name].(*types.TypeName)
				id := x.byName[posKey{file.path, x.offset(s.Name.Pos())}]
				if ok && id != 0 {
					result = append(result, declaredType{id: id, name: name, ident: s.Name, file: file})
				}
			}
		}
	}
	return result
}

func (x *extractor) implement(concrete declaredType, named *types.Named, methods *types.MethodSet, iface declaredType) {
	it, ok := iface.name.Type().Underlying().(*types.Interface)
	if !ok || it.NumMethods() == 0 || iface.id == concrete.id {
		return
	}
	// Cheap name check before the full signature check.
	for i := 0; i < it.NumMethods(); i++ {
		if methods.Lookup(it.Method(i).Pkg(), it.Method(i).Name()) == nil {
			return
		}
	}
	if !types.Implements(named, it) && !types.Implements(types.NewPointer(named), it) {
		return
	}
	// Types from unloaded packages are invalid, and the checker treats any two invalid types as
	// identical. Such signatures must also match as written in source.
	for i := 0; i < it.NumMethods(); i++ {
		selection := methods.Lookup(it.Method(i).Pkg(), it.Method(i).Name())
		if selection == nil || !x.sameSignature(it.Method(i), selection.Obj()) {
			return
		}
	}
	start := x.offset(concrete.ident.Pos())
	x.link(relationFact{
		Kind: "IMPLEMENTS", From: concrete.id, To: iface.id, Path: concrete.file.path,
		Start: start, End: start + len(concrete.ident.Name), Target: iface.name.Name(), Basis: "TYPE_RESOLVED",
	})
	for i := 0; i < it.NumMethods(); i++ {
		contract := it.Method(i)
		selection := methods.Lookup(contract.Pkg(), contract.Name())
		if selection == nil {
			continue
		}
		implementation, _ := x.objectID(selection.Obj())
		target, _ := x.objectID(contract)
		if implementation == 0 || target == 0 || implementation == target {
			continue
		}
		o := x.object(implementation)
		x.link(relationFact{
			Kind: "OVERRIDES", From: implementation, To: target, Path: o.Path,
			Start: o.NameStart, End: o.NameStart + len(o.Name), Target: x.object(target).Name, Basis: "TYPE_RESOLVED",
		})
	}
}

func (x *extractor) link(fact relationFact) {
	key := [2]int{fact.From, fact.To}
	if fact.Kind == "IMPLEMENTS" {
		key[0] = -key[0]
	}
	if x.links[key] {
		return
	}
	x.links[key] = true
	x.out.Relations = append(x.out.Relations, fact)
}

type signatureSource struct {
	file *sourceFile
	typ  *ast.FuncType
}

// sameSignature confirms a method pair whose signatures involve unloaded types by comparing the
// written parameter and result types, qualified by import path.
func (x *extractor) sameSignature(contract, implementation types.Object) bool {
	a, okA := contract.Type().(*types.Signature)
	b, okB := implementation.Type().(*types.Signature)
	if !okA || !okB {
		return false
	}
	if !invalidIn(a, 0) && !invalidIn(b, 0) {
		return true
	}
	keyA, okA := x.signatureKey(contract)
	keyB, okB := x.signatureKey(implementation)
	return okA && okB && keyA == keyB
}

func invalidIn(t types.Type, depth int) bool {
	if depth > 8 || t == nil {
		return false
	}
	switch v := t.(type) {
	case *types.Basic:
		return v.Kind() == types.Invalid
	case *types.Pointer:
		return invalidIn(v.Elem(), depth+1)
	case *types.Slice:
		return invalidIn(v.Elem(), depth+1)
	case *types.Array:
		return invalidIn(v.Elem(), depth+1)
	case *types.Map:
		return invalidIn(v.Key(), depth+1) || invalidIn(v.Elem(), depth+1)
	case *types.Chan:
		return invalidIn(v.Elem(), depth+1)
	case *types.Tuple:
		for i := 0; i < v.Len(); i++ {
			if invalidIn(v.At(i).Type(), depth+1) {
				return true
			}
		}
	case *types.Signature:
		return invalidIn(v.Params(), depth+1) || invalidIn(v.Results(), depth+1)
	case *types.Named:
		for i := 0; i < v.TypeArgs().Len(); i++ {
			if invalidIn(v.TypeArgs().At(i), depth+1) {
				return true
			}
		}
	}
	return false
}

func (x *extractor) signatureKey(obj types.Object) (string, bool) {
	if f, ok := obj.(*types.Func); ok {
		obj = f.Origin()
	}
	position := x.p.fset.Position(obj.Pos())
	source, ok := x.signatures[posKey{position.Filename, position.Offset}]
	if !ok {
		return "", false
	}
	return x.fieldsKey(source.file, source.typ.Params) + "->" + x.fieldsKey(source.file, source.typ.Results), true
}

func (x *extractor) fieldsKey(file *sourceFile, fields *ast.FieldList) string {
	if fields == nil {
		return "()"
	}
	var parts []string
	for _, field := range fields.List {
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		key := x.typeKey(file, field.Type)
		for i := 0; i < count; i++ {
			parts = append(parts, key)
		}
	}
	return "(" + strings.Join(parts, ",") + ")"
}

// typeKey spells a written type with package qualifiers replaced by import paths.
func (x *extractor) typeKey(file *sourceFile, expr ast.Expr) string {
	u := x.unitOf[file]
	switch e := expr.(type) {
	case *ast.Ident:
		if e.Name == "any" {
			return "interface{}"
		}
		if u != nil && u.info != nil {
			if obj := u.info.Uses[e]; obj != nil && obj.Pkg() != nil {
				return obj.Pkg().Path() + "." + e.Name
			}
		}
		return e.Name
	case *ast.SelectorExpr:
		if ident, ok := e.X.(*ast.Ident); ok && u != nil && u.info != nil {
			if name, ok := u.info.Uses[ident].(*types.PkgName); ok {
				return name.Imported().Path() + "." + e.Sel.Name
			}
		}
		return x.typeKey(file, e.X) + "." + e.Sel.Name
	case *ast.BasicLit:
		return e.Value
	case *ast.ParenExpr:
		return x.typeKey(file, e.X)
	case *ast.StarExpr:
		return "*" + x.typeKey(file, e.X)
	case *ast.Ellipsis:
		return "..." + x.typeKey(file, e.Elt)
	case *ast.ArrayType:
		if e.Len == nil {
			return "[]" + x.typeKey(file, e.Elt)
		}
		return "[" + x.typeKey(file, e.Len) + "]" + x.typeKey(file, e.Elt)
	case *ast.MapType:
		return "map[" + x.typeKey(file, e.Key) + "]" + x.typeKey(file, e.Value)
	case *ast.ChanType:
		return "chan " + x.typeKey(file, e.Value)
	case *ast.FuncType:
		return "func" + x.fieldsKey(file, e.Params) + x.fieldsKey(file, e.Results)
	case *ast.InterfaceType:
		if e.Methods == nil || len(e.Methods.List) == 0 {
			return "interface{}"
		}
		return "interface{…}"
	case *ast.StructType:
		return "struct{…}"
	case *ast.IndexExpr:
		return x.typeKey(file, e.X) + "[" + x.typeKey(file, e.Index) + "]"
	case *ast.IndexListExpr:
		var parts []string
		for _, index := range e.Indices {
			parts = append(parts, x.typeKey(file, index))
		}
		return x.typeKey(file, e.X) + "[" + strings.Join(parts, ",") + "]"
	}
	return "?"
}
