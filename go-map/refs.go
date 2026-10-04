package main

import (
	"fmt"
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

type referencesOutput struct {
	References []referenceFact `json:"references"`
}

// findReferences lists every use of the declaration whose name starts at the target offset.
func findReferences(p *program, t target) (referencesOutput, error) {
	file := p.byPath[t.Path]
	if file == nil || file.ast == nil {
		return referencesOutput{}, fmt.Errorf("target file not analyzed")
	}
	var targetObject types.Object
	for _, u := range p.units {
		if u.info == nil {
			continue
		}
		for ident, obj := range u.info.Defs {
			if obj != nil && p.fset.Position(ident.Pos()).Filename == t.Path && p.fset.Position(ident.Pos()).Offset == t.Offset {
				targetObject = obj
				break
			}
		}
		if targetObject != nil {
			break
		}
	}
	if targetObject == nil {
		return referencesOutput{}, fmt.Errorf("no declaration at target")
	}
	key := originKey(p, targetObject)
	output := referencesOutput{References: []referenceFact{}}
	seen := map[[2]int]bool{}
	for _, f := range p.files {
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
			if obj == nil || originKey(p, obj) != key {
				return true
			}
			start := p.fset.Position(ident.Pos()).Offset
			span := [2]int{fileIndex(p, f), start}
			if seen[span] {
				return true
			}
			seen[span] = true
			output.References = append(output.References, referenceFact{
				Path: f.path, Start: start, End: start + len(ident.Name), Kind: referenceKind(stack, declaration),
			})
			return true
		})
	}
	return output, nil
}

func fileIndex(p *program, f *sourceFile) int {
	for i, candidate := range p.files {
		if candidate == f {
			return i
		}
	}
	return -1
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
