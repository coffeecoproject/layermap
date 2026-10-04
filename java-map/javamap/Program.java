package javamap;

import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.DocTrees;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreeScanner;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.stream.Stream;
import javax.lang.model.element.Element;
import javax.lang.model.element.ModuleElement;
import javax.lang.model.element.PackageElement;
import javax.lang.model.util.ElementFilter;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticListener;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;

/**
 * The sources of one map context, parsed and attributed by javac in memory: no class files, no
 * project file reads, no dependencies on the class path. Lombok, when the request names its jar,
 * runs as the annotation processor so the members it generates exist for attribution.
 */
final class Program {
  private static final class Source extends SimpleJavaFileObject {
    final String path;
    final String text;

    Source(String path, String text) {
      super(uri(path), Kind.SOURCE);
      this.path = path;
      this.text = text;
    }

    @Override
    public CharSequence getCharContent(boolean ignoreEncodingErrors) {
      return text;
    }

    // The URI quotes what a path may hold that a URI may not (%, #, ?, brackets and the like).
    private static URI uri(String path) {
      try {
        return new URI("layermap", null, "/" + path, null);
      } catch (URISyntaxException error) {
        throw new Main.Failure("PROJECT_MAP_PROTOCOL_INVALID", "invalid path");
      }
    }
  }

  final JavacTask task;
  final DocTrees trees;
  final Elements elements;
  final Types types;
  final SourcePositions positions;
  final Set<String> tests;
  /** Analyzed compilation units in path order. */
  final Map<String, CompilationUnitTree> units = new TreeMap<>();
  final Map<CompilationUnitTree, String> paths = new IdentityHashMap<>();
  final Map<String, String> texts = new HashMap<>();
  /** Files javac could not parse cleanly; they still take part, so their types stay known. */
  final Set<String> syntaxErrors = new HashSet<>();
  /** Files declaring a type another file declares too: javac enters only the first. */
  final Set<String> duplicateTypes = new HashSet<>();
  /** Errors javac reported in each file besides syntax errors, and those in no file of these. */
  final Map<String, Integer> errors = new HashMap<>();
  int orphanErrors;
  /** For a build, the project's types and what a later build of the context needs from this one. */
  Increment increment;
  /** The files whose classes were attributed, when an incremental build did not attribute all. */
  Set<String> attributed;

  private Program(JavacTask task, Set<String> tests) {
    this.task = task;
    this.trees = DocTrees.instance(task);
    this.elements = task.getElements();
    this.types = task.getTypes();
    this.positions = trees.getSourcePositions();
    this.tests = tests;
  }

  static Program load(Map<String, Object> request) throws Exception {
    Map<String, Object> files = Requests.object(request.get("files"));
    int release = Requests.integer(request, "release", 21);
    String lombok = Requests.optionalString(request, "lombok");
    Set<String> tests = new HashSet<>();
    for (Object path : Requests.list(request, "tests")) tests.add(String.valueOf(path));
    List<Source> sources = new ArrayList<>();
    for (Map.Entry<String, Object> file : new TreeMap<>(files).entrySet()) {
      if (!file.getKey().endsWith(".java") || !(file.getValue() instanceof String text)) continue;
      sources.add(new Source(file.getKey(), text));
    }
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) throw new Main.Failure("PROJECT_MAP_ANALYSIS_FAILED", "no javac in this runtime");
    // With annotation processing javac defers syntax errors to analysis, so a plain parse first
    // tells them apart from type errors.
    final Set<URI> syntax = new HashSet<>();
    DiagnosticListener<JavaFileObject> parsing =
        diagnostic -> {
          if (diagnostic.getKind() == Diagnostic.Kind.ERROR && diagnostic.getSource() != null)
            syntax.add(diagnostic.getSource().toUri());
        };
    Iterable<? extends CompilationUnitTree> plain =
        ((JavacTask)
                compiler.getTask(
                    null,
                    compiler.getStandardFileManager(parsing, null, null),
                    parsing,
                    List.of("-proc:none", "--release", String.valueOf(release)),
                    null,
                    sources))
            .parse();
    List<Source> missing = missingPackages(compiler, release, plain);
    // javac wraps the file objects it is given; their URIs identify them.
    Map<URI, String> byUri = new LinkedHashMap<>();
    for (Source source : sources) byUri.put(source.toUri(), source.path);
    final Map<String, Integer> errors = new HashMap<>();
    final Set<String> duplicates = new HashSet<>();
    final int[] orphan = {0};
    DiagnosticListener<JavaFileObject> listener =
        diagnostic -> {
          if (diagnostic.getKind() != Diagnostic.Kind.ERROR) return;
          URI uri = diagnostic.getSource() == null ? null : diagnostic.getSource().toUri();
          if (uri != null && syntax.contains(uri)) return;
          String path = uri == null ? null : byUri.get(uri);
          if (path == null) orphan[0]++;
          else errors.merge(path, 1, Integer::sum);
          if (path != null && "compiler.err.duplicate.class".equals(diagnostic.getCode()))
            duplicates.add(path);
        };
    List<String> options = new ArrayList<>();
    // Annotation processing makes javac re-enter every tree; only Lombok users pay for it.
    boolean processing =
        lombok != null && sources.stream().anyMatch(source -> source.text.contains("lombok."));
    if (processing) options.addAll(List.of("-proc:full", "-classpath", lombok));
    else options.add("-proc:none");
    options.addAll(
        List.of(
            "--release", String.valueOf(release),
            "-implicit:none",
            "-Xlint:none",
            "-nowarn",
            "-Xmaxerrs", "1000000",
            // Attribute every class despite errors (missing dependencies are expected), then
            // stop: the map needs types, not flow analysis or code generation.
            "-XDshould-stop.ifError=ATTR",
            "-XDshould-stop.ifNoError=ATTR"));
    JavacTask task =
        (JavacTask)
            compiler.getTask(
                null,
                compiler.getStandardFileManager(listener, null, null),
                listener,
                options,
                null,
                Stream.concat(sources.stream(), missing.stream()).toList());
    if (processing) task.setProcessors(LombokRoots.load(lombok));
    Program program = new Program(task, tests);
    for (CompilationUnitTree unit : task.parse()) {
      String path = byUri.get(unit.getSourceFile().toUri());
      if (path == null) continue;
      program.units.put(path, unit);
      program.paths.put(unit, path);
    }
    for (Source source : sources) program.texts.put(source.path, source.text);
    for (CompilationUnitTree unit : program.units.values()) program.parsed(unit);
    for (URI uri : syntax) if (byUri.containsKey(uri)) program.syntaxErrors.add(byUri.get(uri));
    Main.time("parse");
    Set<String> focus = focus(request, program.texts);
    // A record this build cannot read (another format) only costs a full attribution.
    Object incremental = request.get("incremental");
    if (!Increment.usable(incremental)) incremental = null;
    if (focus != null) program.analyze(program.enter(), focus);
    else if (!"BUILD".equals(request.get("operation"))) task.analyze();
    else if (incremental == null) {
      task.analyze();
      program.increment = Increment.of(program, null);
    } else {
      // The previous map's facts of a file stand unless the file or what it used changed.
      Iterable<?> entered = program.enter();
      Main.time("enter");
      program.increment = Increment.of(program, Requests.object(incremental));
      program.attributed = program.increment.attributed(program);
      Main.time("increment");
      if (program.attributed == null) task.analyze();
      else program.analyze(entered, program.attributed);
    }
    Main.time("analyze");
    // An error in no file cannot be told apart from the previous map's: attribute every file.
    if (program.attributed != null && orphan[0] > 0) {
      Map<String, Object> whole = new HashMap<>(request);
      whole.remove("incremental");
      return load(whole);
    }
    program.errors.putAll(errors);
    program.duplicateTypes.addAll(duplicates);
    program.orphanErrors = orphan[0];
    return program;
  }

  /**
   * Enters every class (Lombok runs on them) without attributing any. javac's task offers this,
   * and attributing chosen classes, only on its implementation class, which the relay worker
   * exports to this program.
   */
  private Iterable<?> enter() throws ReflectiveOperationException {
    return (Iterable<?>) task.getClass().getMethod("enter").invoke(task);
  }

  /** Attributes the entered classes of these files only. */
  private void analyze(Iterable<?> entered, Set<String> files) throws ReflectiveOperationException {
    List<Element> classes = new ArrayList<>();
    for (Object value : entered)
      if (value instanceof Element element
          && trees.getPath(element) instanceof TreePath declaration
          && paths.get(declaration.getCompilationUnit()) instanceof String path
          && files.contains(path)) classes.add(element);
    task.getClass().getMethod("analyze", Iterable.class).invoke(task, classes);
  }

  /** Whether a file's classes were attributed. */
  boolean attributed(String path) {
    return attributed == null || attributed.contains(path);
  }

  /**
   * Packages the sources import that neither they nor the platform declare: missing dependencies.
   * Each is declared empty, so javac reports their classes as not found at once. For a class in a
   * package that does not exist, javac first loads it in every module to word a better error,
   * which was about half of the analysis on a Spring project. Modules exist from release 9.
   */
  private static List<Source> missingPackages(
      JavaCompiler compiler, int release, Iterable<? extends CompilationUnitTree> units) {
    if (release < 9) return List.of();
    Set<String> declared = new HashSet<>();
    Set<String> imported = new TreeSet<>();
    for (CompilationUnitTree unit : units) {
      if (unit.getPackageName() != null) declared.add(unit.getPackageName().toString());
      for (ImportTree tree : unit.getImports()) {
        // The package is the leading lower-case names, before a type or the * of the import.
        String[] names = tree.getQualifiedIdentifier().toString().split("\\.");
        StringBuilder name = new StringBuilder();
        for (int index = 0; index < names.length - 1 && Character.isLowerCase(names[index].charAt(0)); index++)
          name.append(name.isEmpty() ? "" : ".").append(names[index]);
        if (!name.isEmpty()) imported.add(name.toString());
      }
    }
    JavacTask probe =
        (JavacTask)
            compiler.getTask(
                null, null, diagnostic -> {}, List.of("-proc:none", "--release", String.valueOf(release)), null, List.of());
    Elements elements = probe.getElements();
    elements.getTypeElement("java.lang.Object");
    Set<String> platform = new HashSet<>();
    for (ModuleElement module : elements.getAllModuleElements())
      for (PackageElement pkg : ElementFilter.packagesIn(module.getEnclosedElements()))
        platform.add(pkg.getQualifiedName().toString());
    List<Source> missing = new ArrayList<>();
    for (String name : imported)
      if (!declared.contains(name) && !platform.contains(name))
        missing.add(new Source("layermap-missing/" + name.replace('.', '/') + "/package-info.java", "package " + name + ";\n"));
    return missing;
  }

  /**
   * For a references request, the files that may refer to the target: its own and those whose
   * text has its name in any case (an accessor Lombok generates for a field changes the case).
   */
  private static Set<String> focus(Map<String, Object> request, Map<String, String> texts) {
    if (!"REFERENCES".equals(request.get("operation"))) return null;
    Map<String, Object> target = Requests.object(request.get("target"));
    String path = Requests.string(target, "path");
    int offset = Requests.integer(target, "offset", -1);
    String text = texts.get(path);
    if (text == null || offset < 0) return null;
    int end = offset;
    while (end < text.length() && Character.isJavaIdentifierPart(text.charAt(end))) end++;
    if (end == offset) return null;
    String name = text.substring(offset, end).toLowerCase(Locale.ROOT);
    Set<String> focus = new HashSet<>(Set.of(path));
    for (Map.Entry<String, String> entry : texts.entrySet())
      if (entry.getValue().toLowerCase(Locale.ROOT).contains(name)) focus.add(entry.getKey());
    return focus;
  }

  /**
   * The declarations and code sites the parser read, before Lombok and javac add theirs (an
   * accessor, a builder, a default constructor, an implicit super() or null check). Generated
   * trees reuse the positions of the annotation or field they come from, so only identity tells.
   */
  private final Set<Tree> parsed = Collections.newSetFromMap(new IdentityHashMap<>());

  private static final Set<Tree.Kind> TRACKED =
      Set.of(
          Tree.Kind.CLASS, Tree.Kind.INTERFACE, Tree.Kind.ENUM, Tree.Kind.RECORD,
          Tree.Kind.ANNOTATION_TYPE, Tree.Kind.METHOD, Tree.Kind.VARIABLE, Tree.Kind.BLOCK,
          Tree.Kind.LAMBDA_EXPRESSION, Tree.Kind.METHOD_INVOCATION, Tree.Kind.NEW_CLASS,
          Tree.Kind.MEMBER_REFERENCE, Tree.Kind.ASSIGNMENT, Tree.Kind.ANNOTATION,
          Tree.Kind.IMPORT);

  private void parsed(CompilationUnitTree unit) {
    new TreeScanner<Void, Void>() {
      @Override
      public Void scan(Tree tree, Void unused) {
        if (tree != null && TRACKED.contains(tree.getKind())) parsed.add(tree);
        return super.scan(tree, unused);
      }
    }.scan(unit, null);
  }

  /** Whether a tree is one the source text has: tracked kinds by identity, others by position. */
  boolean written(CompilationUnitTree unit, Tree tree) {
    if (TRACKED.contains(tree.getKind())) return parsed.contains(tree);
    return positions.getEndPosition(unit, tree) != Diagnostic.NOPOS
        && positions.getStartPosition(unit, tree) != Diagnostic.NOPOS;
  }

  /** The path of an element's declaration in these sources, if it was written there. */
  TreePath source(Element element) {
    if (element == null) return null;
    TreePath path = trees.getPath(element);
    if (path == null || !paths.containsKey(path.getCompilationUnit())) return null;
    return written(path.getCompilationUnit(), path.getLeaf()) ? path : null;
  }

  /** Whether an element is one of these sources' own, though perhaps generated (Lombok). */
  boolean local(Element element) {
    if (element == null) return false;
    TreePath path = trees.getPath(element);
    return path != null && paths.containsKey(path.getCompilationUnit());
  }

  /** Whether an element belongs to the Java platform (a java.* or jdk.* module). */
  boolean platform(Element element) {
    if (element == null) return false;
    var module = elements.getModuleOf(element);
    if (module == null || module.isUnnamed()) return false;
    String name = module.getQualifiedName().toString();
    return name.startsWith("java.") || name.startsWith("jdk.");
  }
}
