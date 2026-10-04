package main

import (
	"go/ast"
	"go/build/constraint"
	"go/parser"
	"go/token"
	"go/types"
	"path"
	"regexp"
	"sort"
	"strings"
)

// The map is built for one fixed platform so that results do not depend on the host machine.
const (
	targetOS   = "linux"
	targetArch = "amd64"
)

var knownOS = map[string]bool{
	"aix": true, "android": true, "darwin": true, "dragonfly": true, "freebsd": true, "hurd": true,
	"illumos": true, "ios": true, "js": true, "linux": true, "nacl": true, "netbsd": true,
	"openbsd": true, "plan9": true, "solaris": true, "wasip1": true, "windows": true, "zos": true,
}
var knownArch = map[string]bool{
	"386": true, "amd64": true, "amd64p32": true, "arm": true, "armbe": true, "arm64": true,
	"arm64be": true, "loong64": true, "mips": true, "mipsle": true, "mips64": true, "mips64le": true,
	"mips64p32": true, "mips64p32le": true, "ppc": true, "ppc64": true, "ppc64le": true, "riscv": true,
	"riscv64": true, "s390": true, "s390x": true, "sparc": true, "sparc64": true, "wasm": true,
}

var releaseTag = regexp.MustCompile(`^go1\.(\d+)$`)

// satisfied reports whether a build tag holds for the fixed platform without cgo.
func satisfied(tag string) bool {
	switch tag {
	case targetOS, targetArch, "unix", "gc":
		return true
	}
	return releaseTag.MatchString(tag)
}

type sourceFile struct {
	path     string
	text     []byte
	ast      *ast.File
	test     bool
	external bool // an external test package (package x_test)
	// Why the file is not part of the analyzed program, when it is not.
	excluded string
}

// unit is one type-checked package variant: the package itself, the package with its internal
// tests, or its external test package.
type unit struct {
	importPath string
	dir        string
	files      []*sourceFile
	pkg        *types.Package
	info       *types.Info
	checking   bool
}

type program struct {
	fset       *token.FileSet
	modulePath string
	moduleDir  string
	files      []*sourceFile
	byPath     map[string]*sourceFile
	// Base units by import path, and the variants that include tests, by directory.
	base      map[string]*unit
	tested    map[string]*unit
	external  map[string]*unit
	units     []*unit
	placehold map[string]*types.Package
	// The unit that describes each file: its package, before the variant with internal tests.
	owner  map[*sourceFile]*unit
	errors int
}

var moduleLine = regexp.MustCompile(`(?m)^\s*module\s+("(?:[^"\\]|\\.)*"|\S+)`)

func load(input request) *program {
	p := &program{
		fset:      token.NewFileSet(),
		byPath:    map[string]*sourceFile{},
		base:      map[string]*unit{},
		tested:    map[string]*unit{},
		external:  map[string]*unit{},
		placehold: map[string]*types.Package{},
	}
	if input.ModFile != "" {
		p.moduleDir = path.Dir(input.ModFile)
		if p.moduleDir == "." {
			p.moduleDir = ""
		}
		if match := moduleLine.FindStringSubmatch(input.Files[input.ModFile]); match != nil {
			p.modulePath = strings.Trim(match[1], `"`)
		}
	}
	names := make([]string, 0, len(input.Files))
	for name := range input.Files {
		if strings.HasSuffix(name, ".go") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		text := []byte(input.Files[name])
		file := &sourceFile{path: name, text: text, test: strings.HasSuffix(name, "_test.go")}
		p.files = append(p.files, file)
		p.byPath[name] = file
		if ignoredDirectory(strings.TrimPrefix(name, p.moduleDir+"/")) {
			file.excluded = "IGNORED_DIRECTORY"
			continue
		}
		if !goodOSArchFile(path.Base(name)) {
			file.excluded = "BUILD_CONSTRAINT_EXCLUDED"
			continue
		}
		parsed, err := parser.ParseFile(p.fset, name, text, parser.ParseComments|parser.SkipObjectResolution)
		if err != nil || parsed == nil {
			file.excluded = "SYNTAX_ERROR"
			continue
		}
		if !constraintsHold(parsed) {
			file.excluded = "BUILD_CONSTRAINT_EXCLUDED"
			continue
		}
		if importsC(parsed) {
			// cgo files are excluded when cgo is disabled, as the go command does.
			file.excluded = "BUILD_CONSTRAINT_EXCLUDED"
			continue
		}
		file.ast = parsed
		file.external = file.test && strings.HasSuffix(parsed.Name.Name, "_test")
	}
	p.group()
	p.check()
	return p
}

// goodOSArchFile applies the go command's file name constraints (name_GOOS_GOARCH.go).
func goodOSArchFile(name string) bool {
	name = strings.TrimSuffix(name, ".go")
	name = strings.TrimSuffix(name, "_test")
	if i := strings.Index(name, "_"); i < 0 {
		return true
	} else {
		name = name[i:]
	}
	parts := strings.Split(name, "_")
	n := len(parts)
	if n >= 2 && knownOS[parts[n-2]] && knownArch[parts[n-1]] {
		return parts[n-2] == targetOS && parts[n-1] == targetArch
	}
	if n >= 1 && knownOS[parts[n-1]] {
		return parts[n-1] == targetOS
	}
	if n >= 1 && knownArch[parts[n-1]] {
		return parts[n-1] == targetArch
	}
	return true
}

// constraintsHold evaluates //go:build lines in the file header.
func constraintsHold(file *ast.File) bool {
	for _, group := range file.Comments {
		if group.Pos() >= file.Package {
			break
		}
		for _, comment := range group.List {
			if !constraint.IsGoBuild(comment.Text) {
				continue
			}
			expr, err := constraint.Parse(comment.Text)
			if err != nil {
				return false
			}
			return expr.Eval(satisfied)
		}
	}
	return true
}

func importsC(file *ast.File) bool {
	for _, spec := range file.Imports {
		if spec.Path.Value == `"C"` {
			return true
		}
	}
	return false
}

func (p *program) importPathOf(dir string) string {
	if p.modulePath == "" {
		return ""
	}
	rel := strings.TrimPrefix(strings.TrimPrefix(dir, p.moduleDir), "/")
	if p.moduleDir == "" {
		rel = dir
		if rel == "." {
			rel = ""
		}
	}
	if rel == "" {
		return p.modulePath
	}
	return p.modulePath + "/" + rel
}

// group forms the package variants of each directory, as the go command does for tests.
func (p *program) group() {
	byDir := map[string][]*sourceFile{}
	var dirs []string
	for _, file := range p.files {
		if file.ast == nil {
			continue
		}
		dir := path.Dir(file.path)
		if _, ok := byDir[dir]; !ok {
			dirs = append(dirs, dir)
		}
		byDir[dir] = append(byDir[dir], file)
	}
	sort.Strings(dirs)
	for _, dir := range dirs {
		// The package name is the one the non-test files agree on; mismatching files stay out.
		counts := map[string]int{}
		for _, file := range byDir[dir] {
			if !file.external {
				counts[file.ast.Name.Name]++
			}
		}
		name := ""
		for candidate, count := range counts {
			if count > counts[name] || (count == counts[name] && candidate < name) {
				name = candidate
			}
		}
		importPath := p.importPathOf(dir)
		if importPath == "" {
			importPath = "layermap-local/" + dir
		}
		base := &unit{importPath: importPath, dir: dir}
		tested := &unit{importPath: importPath, dir: dir}
		external := &unit{importPath: importPath + "_test", dir: dir}
		for _, file := range byDir[dir] {
			switch {
			case file.external:
				if file.ast.Name.Name != name+"_test" && name != "" {
					file.excluded = "PACKAGE_NAME_MISMATCH"
					file.ast = nil
					continue
				}
				external.files = append(external.files, file)
			case file.ast.Name.Name != name:
				file.excluded = "PACKAGE_NAME_MISMATCH"
				file.ast = nil
			case file.test:
				tested.files = append(tested.files, file)
			default:
				base.files = append(base.files, file)
				tested.files = append(tested.files, file)
			}
		}
		if len(base.files) > 0 || len(tested.files) > 0 {
			p.base[importPath] = base
			p.units = append(p.units, base)
		}
		if len(tested.files) > len(base.files) {
			p.tested[dir] = tested
			p.units = append(p.units, tested)
		}
		if len(external.files) > 0 {
			p.external[dir] = external
			p.units = append(p.units, external)
		}
	}
}

// check type-checks every unit. Imports inside the module come from source; the standard library
// and other modules are empty placeholder packages, so uses of them stay unresolved.
func (p *program) check() {
	p.owner = map[*sourceFile]*unit{}
	for _, u := range p.units {
		for _, file := range u.files {
			if _, seen := p.owner[file]; !seen {
				p.owner[file] = u
			}
		}
	}
	for _, u := range p.units {
		p.checkUnit(u)
	}
}

type unitImporter struct {
	p *program
	// The directory whose test variant replaces its base package (for external tests).
	testedDir string
}

func (im unitImporter) Import(importPath string) (*types.Package, error) {
	return im.ImportFrom(importPath, "", 0)
}

func (im unitImporter) ImportFrom(importPath, _ string, _ types.ImportMode) (*types.Package, error) {
	p := im.p
	if u, ok := p.base[importPath]; ok {
		if im.testedDir != "" && u.dir == im.testedDir {
			if tested, ok := p.tested[u.dir]; ok {
				p.checkUnit(tested)
				if tested.pkg != nil {
					return tested.pkg, nil
				}
			}
		}
		p.checkUnit(u)
		if u.pkg != nil && !u.checking {
			return u.pkg, nil
		}
	}
	return p.placeholder(importPath), nil
}

func (p *program) placeholder(importPath string) *types.Package {
	if pkg, ok := p.placehold[importPath]; ok {
		return pkg
	}
	pkg := types.NewPackage(importPath, packageNameGuess(importPath))
	pkg.MarkComplete()
	p.placehold[importPath] = pkg
	return pkg
}

var majorVersion = regexp.MustCompile(`^v\d+$`)

// packageNameGuess derives the conventional package name from an import path.
func packageNameGuess(importPath string) string {
	parts := strings.Split(importPath, "/")
	name := parts[len(parts)-1]
	if majorVersion.MatchString(name) && len(parts) > 1 {
		name = parts[len(parts)-2]
	}
	if i := strings.Index(name, ".v"); strings.HasPrefix(importPath, "gopkg.in/") && i > 0 {
		name = name[:i]
	}
	name = strings.TrimPrefix(name, "go-")
	return strings.Map(func(r rune) rune {
		if r == '-' || r == '.' {
			return '_'
		}
		return r
	}, name)
}

// ignoredDirectory reports whether a file (by its path in the module) sits in a directory the go
// command ignores: one named testdata, or whose name starts with _ or . (fixtures and tooling).
func ignoredDirectory(name string) bool {
	parts := strings.Split(name, "/")
	for _, part := range parts[:len(parts)-1] {
		if part == "testdata" || strings.HasPrefix(part, "_") || strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

// isStandard reports whether an import path belongs to the standard library.
func isStandard(importPath string) bool {
	first := strings.SplitN(importPath, "/", 2)[0]
	return !strings.Contains(first, ".")
}

func (p *program) checkUnit(u *unit) {
	if u.pkg != nil || u.checking || len(u.files) == 0 {
		return
	}
	u.checking = true
	defer func() { u.checking = false }()
	testedDir := ""
	if _, ok := p.external[u.dir]; ok && u == p.external[u.dir] {
		testedDir = u.dir
	}
	var reported []types.Error
	config := types.Config{
		Importer:    unitImporter{p: p, testedDir: testedDir},
		FakeImportC: true,
		Error: func(err error) {
			if typed, ok := err.(types.Error); ok {
				reported = append(reported, typed)
			} else {
				p.errors++
			}
		},
	}
	u.info = &types.Info{
		Types:      map[ast.Expr]types.TypeAndValue{},
		Defs:       map[*ast.Ident]types.Object{},
		Uses:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
		Implicits:  map[ast.Node]types.Object{},
	}
	files := make([]*ast.File, 0, len(u.files))
	for _, file := range u.files {
		files = append(files, file.ast)
	}
	pkg, _ := config.Check(u.importPath, p.fset, files, u.info)
	u.pkg = pkg
	p.countErrors(u, reported)
}

// countErrors counts a unit's type errors in the files it describes (a variant with internal
// tests checks its package's files again), leaving out each use of a member of a placeholder
// package: those packages are empty by design, so every such use is reported undefined.
func (p *program) countErrors(u *unit, reported []types.Error) {
	placeholderUses := map[token.Pos]bool{}
	for _, file := range u.files {
		ast.Inspect(file.ast, func(node ast.Node) bool {
			selector, ok := node.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if name, ok := selector.X.(*ast.Ident); ok {
				if imported, ok := u.info.Uses[name].(*types.PkgName); ok &&
					p.placehold[imported.Imported().Path()] == imported.Imported() {
					placeholderUses[selector.Sel.Pos()] = true
				}
			}
			return true
		})
	}
	for _, err := range reported {
		if placeholderUses[err.Pos] {
			continue
		}
		position := p.fset.Position(err.Pos)
		if file := p.byPath[position.Filename]; file != nil && p.owner[file] != u {
			continue
		}
		p.errors++
	}
}
