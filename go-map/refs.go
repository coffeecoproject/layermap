package main

import (
	"go/ast"
	"go/token"
	"go/types"
)

type referenceFact struct {
	Path  string `json:"path"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Kind  string `json:"kind"`
}

type referencePage struct {
	References []referenceFact `json:"references"`
}

type referencesOutput struct {
	Pages []*referencePage `json:"pages"`
}

// findReferences lists every use of the declarations whose names start at the target offsets, in
// one walk of the program. A target that names no declaration has a null page.
func findReferences(p *program, targets []target) referencesOutput {
	output := referencesOutput{Pages: make([]*referencePage, len(targets))}
	wanted := map[token.Position]*referencePage{}
	at := map[target][]int{}
	for i, t := range targets {
		at[t] = append(at[t], i)
	}
	for _, u := range p.units {
		if u.info == nil {
			continue
		}
		for ident, obj := range u.info.Defs {
			if obj == nil {
				continue
			}
			position := p.fset.Position(ident.Pos())
			for _, i := range at[target{Path: position.Filename, Offset: position.Offset}] {
				if output.Pages[i] != nil {
					continue
				}
				key := originKey(p, obj)
				page := wanted[key]
				if page == nil {
					page = &referencePage{References: []referenceFact{}}
					wanted[key] = page
				}
				output.Pages[i] = page
			}
		}
	}
	seen := map[[2]int]bool{}
	for index, f := range p.files {
		if f.ast == nil {
			continue
		}
		// A file is described by the first unit that contains it (its base package when it has one).
		var u *unit
		for _, candidate := range p.units {
			for _, member := range candidate.files {
				if member == f && candidate.info != nil {
					u = candidate
					break
				}
			}
			if u != nil {
				break
			}
		}
		if u == nil {
			continue
		}
		var stack []ast.Node
		ast.Inspect(f.ast, func(n ast.Node) bool {
			if n == nil {
				stack = stack[:len(stack)-1]
				return false
			}
			stack = append(stack, n)
			ident, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			obj := u.info.Uses[ident]
			declaration := false
			if obj == nil {
				obj = u.info.Defs[ident]
				declaration = obj != nil
			}
			if obj == nil {
				return true
			}
			page := wanted[originKey(p, obj)]
			if page == nil {
				return true
			}
			start := p.fset.Position(ident.Pos()).Offset
			span := [2]int{index, start}
			if seen[span] {
				return true
			}
			seen[span] = true
			page.References = append(page.References, referenceFact{
				Path: f.path, Start: start, End: start + len(ident.Name), Kind: referenceKind(stack, declaration),
			})
			return true
		})
	}
	return output
}

// originKey identifies a declaration across package variants by the position of its name.
func originKey(p *program, obj types.Object) token.Position {
	switch o := obj.(type) {
	case *types.Func:
		obj = o.Origin()
	case *types.Var:
		obj = o.Origin()
	}
	position := p.fset.Position(obj.Pos())
	position.Line, position.Column = 0, 0
	return position
}

// referenceKind classifies a use by its syntactic role; the stack ends with the identifier.
func referenceKind(stack []ast.Node, declaration bool) string {
	if declaration {
		return "DECLARATION"
	}
	n := len(stack)
	ident := stack[n-1]
	var expr ast.Node = ident
	parentAt := n - 2
	if parentAt >= 0 {
		if selector, ok := stack[parentAt].(*ast.SelectorExpr); ok && selector.Sel == ident {
			expr = selector
			parentAt--
		}
	}
	if parentAt < 0 {
		return "REFERENCE"
	}
	switch parent := stack[parentAt].(type) {
	case *ast.CallExpr:
		if parent.Fun == expr {
			return "CALL"
		}
	case *ast.AssignStmt:
		if parent.Tok != token.DEFINE {
			for _, lhs := range parent.Lhs {
				if lhs == expr {
					return "WRITE"
				}
			}
		}
	case *ast.IncDecStmt:
		if parent.X == expr {
			return "WRITE"
		}
	case *ast.ImportSpec:
		return "IMPORT_EXPORT"
	}
	if _, ok := expr.(*ast.SelectorExpr); ok {
		return "READ"
	}
	return "REFERENCE"
}
