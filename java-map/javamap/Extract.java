package javamap;

import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.ArrayAccessTree;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.BlockTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.CompoundAssignmentTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ModifiersTree;
import com.sun.source.tree.NewArrayTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TryTree;
import com.sun.source.tree.TypeCastTree;
import com.sun.source.tree.UnaryTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.ExecutableType;
import javax.lang.model.type.IntersectionType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.type.UnionType;
import javax.lang.model.type.WildcardType;
import javax.tools.Diagnostic;

/**
 * The map facts of a program: the declarations written in its sources and their relations
 * (calls, uses as a value, writes, heritage, overrides, annotations, imports), with why a target
 * stays unresolved.
 */
final class Extract {
  // Compiler hints that say nothing about behavior; every override would carry @Override.
  private static final Set<String> HINTS = Set.of("java.lang.Override", "java.lang.SuppressWarnings");
  private static final Set<String> HTTP_METHODS =
      Set.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE");
  // An annotation named for the HTTP method it maps, as GetMapping is (not PostConstruct).
  private static final java.util.regex.Pattern NAMED_METHOD =
      java.util.regex.Pattern.compile("^(Get|Head|Post|Put|Patch|Delete|Options|Trace)Mapping$");

  private final Program p;
  private final List<Map<String, Object>> files = new ArrayList<>();
  private final List<Map<String, Object>> objects = new ArrayList<>();
  private final List<Map<String, Object>> relations = new ArrayList<>();
  private final List<Map<String, Object>> notes = new ArrayList<>();
  /** Declarations written in the sources, by javac element, in declaration order. */
  private final Map<Element, Integer> declared = new LinkedHashMap<>();
  /** Every object's declaration tree (lambdas and initializer blocks have no element). */
  private final Map<Tree, Integer> trees = new IdentityHashMap<>();
  /** Where each object's name is: path, start, length. */
  private final Map<Integer, Object[]> names = new HashMap<>();
  private final Map<String, Integer> fileObjects = new HashMap<>();
  private final Map<String, List<Integer>> packages = new HashMap<>();
  /** The project types each attributed file's code used, for the next incremental build. */
  private final Map<String, Set<String>> uses = new HashMap<>();
  /** Each project type with its supertypes, by qualified name. */
  private final Map<TypeElement, Set<String>> lineages = new IdentityHashMap<>();
  /** The qualified names of the project's types. */
  private final Set<String> projectTypes;
  private int next = 1;

  Extract(Program program) {
    this.p = program;
    this.projectTypes = new HashSet<>(program.increment.types.values());
  }

  static Map<String, Object> fact(Object... pairs) {
    Map<String, Object> fact = new LinkedHashMap<>();
    for (int index = 0; index < pairs.length; index += 2)
      if (pairs[index + 1] != null) fact.put((String) pairs[index], pairs[index + 1]);
    return fact;
  }

  /**
   * The facts of the program. An incremental build lists the files it attributed as its focus:
   * only their objects, relations and notes are theirs; every other file's are the previous
   * build's, and the declarations it writes are listed only so links into it are identified.
   */
  Map<String, Object> run() {
    for (Map.Entry<String, CompilationUnitTree> unit : p.units.entrySet())
      if (!p.syntaxErrors.contains(unit.getKey())) declare(unit.getKey(), unit.getValue());
    for (Map.Entry<String, CompilationUnitTree> unit : p.units.entrySet())
      if (!p.syntaxErrors.contains(unit.getKey()) && p.attributed(unit.getKey())) {
        Relater relater = new Relater(unit.getKey(), unit.getValue());
        relater.scan(unit.getValue(), null);
        uses.put(unit.getKey(), relater.used);
      }
    overrides();
    for (String path : p.units.keySet())
      files.add(
          p.syntaxErrors.contains(path)
              ? fact("path", path, "excluded", "SYNTAX_ERROR")
              : fact(
                  "path", path, "object", fileObjects.get(path),
                  "issue", p.duplicateTypes.contains(path) ? "DUPLICATE_TYPE" : null));
    Map<String, Object> state = p.increment.state(p, uses);
    return fact(
        "files", files, "objects", objects, "relations", relations, "notes", notes,
        "typeErrors", p.increment.typeErrors,
        "focus", p.attributed == null ? null : List.copyOf(p.attributed),
        "state", state);
  }

  private int object(
      String kind,
      String name,
      String path,
      long start,
      long end,
      long nameStart,
      Integer parent,
      boolean exported,
      String execution) {
    int id = next++;
    objects.add(
        fact(
            "id", id, "kind", kind, "name", name, "path", path, "start", start, "end", end,
            "nameStart", nameStart, "parent", parent, "exported", exported,
            "execution", execution));
    if (nameStart >= 0) names.put(id, new Object[] {path, nameStart, (long) name.length()});
    return id;
  }

  private Map<String, Object> relation(
      String kind, int from, String path, long start, long end, String target) {
    Map<String, Object> relation =
        fact("kind", kind, "from", from, "path", path, "start", start, "end", end, "target", target);
    relations.add(relation);
    return relation;
  }

  private static void resolved(Map<String, Object> relation, int to) {
    relation.put("to", to);
    relation.put("basis", "TYPE_RESOLVED");
  }

  private static void unresolved(Map<String, Object> relation, String reason) {
    relation.put("basis", "UNRESOLVED");
    relation.put("reason", reason);
  }

  // Pass 1: the declarations each file writes.
  private void declare(String path, CompilationUnitTree unit) {
    String text = p.texts.get(path);
    int file = object("FILE", path, path, 0, text.length(), -1, null, false, null);
    fileObjects.put(path, file);
    String pkg = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
    packages.computeIfAbsent(pkg, key -> new ArrayList<>()).add(file);
    boolean attributed = p.attributed(path);
    new TreePathScanner<Void, Integer>() {
      private void register(Tree tree, int id) {
        trees.put(tree, id);
        // A declaration in code (a local or anonymous class) has an element only once its class
        // is attributed, and asking for it would attribute the class.
        if (attributed || member(getCurrentPath())) {
          Element element = p.trees.getElement(getCurrentPath());
          if (element != null) declared.put(element, id);
        }
        documentation(unit, path, tree, id);
      }

      @Override
      public Void visitClass(ClassTree node, Integer parent) {
        if (!p.written(unit, node)) return null;
        boolean top = getCurrentPath().getParentPath().getLeaf() instanceof CompilationUnitTree;
        String name = node.getSimpleName().toString();
        boolean anonymous = name.isEmpty();
        if (anonymous) name = "<anonymous " + anonymousBase(getCurrentPath()) + ">";
        int id =
            object(
                switch (node.getKind()) {
                  case INTERFACE, ANNOTATION_TYPE -> "INTERFACE";
                  case ENUM -> "ENUM";
                  default -> "CLASS";
                },
                name, path, start(unit, node), end(unit, node),
                anonymous ? -1 : nameStart(unit, node, name, after(unit, node.getModifiers(), 0)),
                parent, top && node.getModifiers().getFlags().contains(Modifier.PUBLIC), null);
        register(node, id);
        return super.visitClass(node, id);
      }

      @Override
      public Void visitMethod(MethodTree node, Integer parent) {
        if (!p.written(unit, node)) return null;
        boolean constructor = node.getReturnType() == null;
        String name = constructor ? enclosingClassName(getCurrentPath()) : node.getName().toString();
        long from =
            constructor
                ? after(unit, node.getModifiers(), 0)
                : after(unit, node.getReturnType(), after(unit, node.getModifiers(), 0));
        int id =
            object(
                "METHOD", name, path, start(unit, node), end(unit, node),
                nameStart(unit, node, name, from), parent, false,
                // An abstract or interface method has no body: it runs nothing itself.
                constructor ? "CONSTRUCTOR" : node.getBody() == null ? null : "FUNCTION");
        register(node, id);
        return super.visitMethod(node, id);
      }

      @Override
      public Void visitVariable(VariableTree node, Integer parent) {
        if (!(getCurrentPath().getParentPath().getLeaf() instanceof ClassTree))
          return super.visitVariable(node, parent);
        if (!p.written(unit, node)) return null;
        String name = node.getName().toString();
        int id =
            object(
                "PROPERTY", name, path, start(unit, node), end(unit, node),
                nameStart(unit, node, name, after(unit, node.getType(), 0)), parent, false,
                node.getInitializer() != null ? "INITIALIZER" : null);
        register(node, id);
        return super.visitVariable(node, id);
      }

      @Override
      public Void visitBlock(BlockTree node, Integer parent) {
        if (!(getCurrentPath().getParentPath().getLeaf() instanceof ClassTree)
            || !p.written(unit, node)) return super.visitBlock(node, parent);
        int id =
            object(
                "FUNCTION", node.isStatic() ? "<static initializer>" : "<initializer>", path,
                start(unit, node), end(unit, node), -1, parent, false, "INITIALIZER");
        trees.put(node, id);
        return super.visitBlock(node, id);
      }

      @Override
      public Void visitLambdaExpression(LambdaExpressionTree node, Integer parent) {
        if (!p.written(unit, node)) return super.visitLambdaExpression(node, parent);
        int id =
            object(
                "FUNCTION", "<lambda>", path, start(unit, node), end(unit, node), -1, parent,
                false, "CLOSURE");
        trees.put(node, id);
        return super.visitLambdaExpression(node, id);
      }
    }.scan(unit, file);
  }

  // Whether a declaration is a member of a type or package, not of code.
  private static boolean member(TreePath path) {
    for (TreePath at = path.getParentPath(); at != null; at = at.getParentPath())
      if (!(at.getLeaf() instanceof ClassTree) && !(at.getLeaf() instanceof CompilationUnitTree))
        return false;
    return true;
  }

  private String anonymousBase(TreePath path) {
    Tree parent = path.getParentPath().getLeaf();
    return parent instanceof NewClassTree created ? label(created.getIdentifier()) : "class";
  }

  private static String enclosingClassName(TreePath path) {
    for (TreePath at = path; at != null; at = at.getParentPath())
      if (at.getLeaf() instanceof ClassTree type) return type.getSimpleName().toString();
    return "<init>";
  }

  private long start(CompilationUnitTree unit, Tree tree) {
    return p.positions.getStartPosition(unit, tree);
  }

  private long end(CompilationUnitTree unit, Tree tree) {
    return p.positions.getEndPosition(unit, tree);
  }

  // Where a tree ends, or the fallback when it was not written (no modifiers, implicit type).
  private long after(CompilationUnitTree unit, Tree tree, long fallback) {
    if (tree == null) return fallback;
    long end = p.positions.getEndPosition(unit, tree);
    return end == Diagnostic.NOPOS ? fallback : end;
  }

  // The declared name as a whole identifier after the modifiers or type that precede it.
  private long nameStart(CompilationUnitTree unit, Tree tree, String name, long from) {
    String text = p.texts.get(p.paths.get(unit));
    int start = (int) Math.max(from, start(unit, tree));
    int stop = (int) Math.min(text.length(), end(unit, tree));
    for (int at = text.indexOf(name, start);
        at >= 0 && at + name.length() <= stop;
        at = text.indexOf(name, at + 1)) {
      boolean before = at == 0 || !Character.isJavaIdentifierPart(text.charAt(at - 1));
      int after = at + name.length();
      boolean behind = after >= text.length() || !Character.isJavaIdentifierPart(text.charAt(after));
      if (before && behind) return at;
    }
    return -1;
  }

  // A Javadoc comment right before a declaration documents it.
  private void documentation(CompilationUnitTree unit, String path, Tree tree, int id) {
    String text = p.texts.get(path);
    int at = (int) start(unit, tree) - 1;
    while (at >= 0 && Character.isWhitespace(text.charAt(at))) at--;
    if (at < 3 || text.charAt(at) != '/' || text.charAt(at - 1) != '*') return;
    int open = text.lastIndexOf("/**", at - 2);
    if (open < 0 || text.lastIndexOf("*/", at - 2) > open) return;
    notes.add(
        fact("object", id, "kind", "SOURCE_DOCUMENTATION", "path", path, "start", open, "end", at + 1));
  }

  static String label(Tree tree) {
    return switch (tree) {
      case IdentifierTree identifier -> identifier.getName().toString();
      case MemberSelectTree member -> label(member.getExpression()) + "." + member.getIdentifier();
      case MethodInvocationTree call -> label(call.getMethodSelect()) + "()";
      case NewClassTree created -> label(created.getIdentifier()) + "()";
      case ArrayAccessTree access -> label(access.getExpression()) + "[…]";
      case ParenthesizedTree group -> label(group.getExpression());
      case TypeCastTree cast -> label(cast.getExpression());
      case ParameterizedTypeTree generic -> label(generic.getType());
      case AnnotatedTypeTree annotated -> label(annotated.getUnderlyingType());
      case null -> "…";
      default -> "…";
    };
  }

  /**
   * The object a resolved element stands for. A member javac or Lombok generated (an accessor, a
   * builder, a constructor, a record member) has no declaration of its own: an accessor stands
   * for the field it reads or writes, a constructor or builder for the type it makes.
   */
  private Integer linked(Element element) {
    if (element == null) return null;
    Integer id = declared.get(element);
    if (id != null) return id;
    Element owner = element.getEnclosingElement();
    // A member javac declares without a tree, such as an enum's values and valueOf, stands for
    // the type that has it.
    if (!p.local(element))
      return element instanceof ExecutableElement && owner instanceof TypeElement type
          ? declared.get(type)
          : null;
    TypeElement written = null;
    for (Element at = owner; at != null; at = at.getEnclosingElement())
      if (at instanceof TypeElement type && declared.containsKey(type)) {
        written = type;
        break;
      }
    if (written == null) return null;
    String name = element.getSimpleName().toString();
    if (element.getKind() == ElementKind.CONSTRUCTOR || Set.of("builder", "build", "toBuilder").contains(name))
      return declared.get(written);
    if (!(element instanceof ExecutableElement) && !element.getKind().isField()) return null;
    for (String field : fieldNames(name))
      for (Element scope : owner == written ? List.of(written) : List.of(owner, written))
        for (Element member : scope.getEnclosedElements())
          if (member.getKind().isField() && member.getSimpleName().contentEquals(field)) {
            Integer target = declared.get(member);
            if (target != null) return target;
          }
    return null;
  }

  private static List<String> fieldNames(String name) {
    List<String> names = new ArrayList<>(List.of(name));
    for (String prefix : List.of("get", "set", "with", "is"))
      if (name.length() > prefix.length()
          && name.startsWith(prefix)
          && Character.isUpperCase(name.charAt(prefix.length()))) {
        String rest = name.substring(prefix.length());
        names.add(Character.toLowerCase(rest.charAt(0)) + rest.substring(1));
      }
    return names;
  }

  private boolean erroneous(TypeMirror type) {
    return type == null || type.getKind() == TypeKind.ERROR;
  }

  // Whether a type's own class or one of its supertypes could not be loaded.
  private boolean incomplete(TypeElement type) {
    Deque<TypeMirror> pending = new ArrayDeque<>(List.of(type.asType()));
    Set<Element> seen = new HashSet<>();
    while (!pending.isEmpty()) {
      TypeMirror current = pending.pop();
      if (erroneous(current)) return true;
      if (!(current instanceof DeclaredType declaredType) || !seen.add(declaredType.asElement()))
        continue;
      pending.addAll(p.types.directSupertypes(current));
    }
    return false;
  }

  private void overrides() {
    for (Map.Entry<Element, Integer> entry : new ArrayList<>(declared.entrySet())) {
      if (!(entry.getKey() instanceof ExecutableElement method)
          || method.getKind() != ElementKind.METHOD
          || method.getModifiers().contains(Modifier.STATIC)
          || !(method.getEnclosingElement() instanceof TypeElement type)) continue;
      Object[] name = names.get(entry.getValue());
      if (name == null || !p.attributed((String) name[0])) continue;
      Deque<TypeMirror> pending = new ArrayDeque<>(p.types.directSupertypes(type.asType()));
      Set<Element> seen = new HashSet<>();
      while (!pending.isEmpty()) {
        TypeMirror current = pending.pop();
        if (!(current instanceof DeclaredType declaredType) || erroneous(current)) continue;
        Element superType = declaredType.asElement();
        if (!seen.add(superType)) continue;
        pending.addAll(p.types.directSupertypes(current));
        for (Element member : superType.getEnclosedElements()) {
          if (member.getKind() != ElementKind.METHOD
              || !member.getSimpleName().equals(method.getSimpleName())) continue;
          Integer base = declared.get(member);
          if (base == null || !p.elements.overrides(method, (ExecutableElement) member, type))
            continue;
          long start = (long) name[1];
          resolved(
              relation(
                  "OVERRIDES", entry.getValue(), (String) name[0], start, start + (long) name[2],
                  member.getSimpleName().toString()),
              base);
        }
      }
    }
  }

  /** A project type and its project supertypes, by qualified name. */
  private Set<String> lineage(TypeElement type) {
    Set<String> known = lineages.get(type);
    if (known != null) return known;
    Set<String> lineage = new HashSet<>();
    // A cycle (an inheritance error) ends at a type being described.
    lineages.put(type, lineage);
    String name = p.increment.types.get(type);
    if (name == null) return lineage;
    lineage.add(name);
    Set<String> found = new HashSet<>(List.of(name));
    for (TypeMirror supertype : p.types.directSupertypes(type.asType())) collect(found, supertype);
    lineage.addAll(found);
    return lineage;
  }

  /** The project types a type mirror names, with their supertypes. */
  private void collect(Set<String> into, TypeMirror type) {
    switch (type) {
      case null -> {}
      case DeclaredType declared -> {
        if (declared.asElement() instanceof TypeElement element) into.addAll(lineage(element));
        for (TypeMirror argument : declared.getTypeArguments()) collect(into, argument);
      }
      case ArrayType array -> collect(into, array.getComponentType());
      case WildcardType wildcard -> {
        collect(into, wildcard.getExtendsBound());
        collect(into, wildcard.getSuperBound());
      }
      case IntersectionType intersection -> {
        for (TypeMirror bound : intersection.getBounds()) collect(into, bound);
      }
      case UnionType union -> {
        for (TypeMirror alternative : union.getAlternatives()) collect(into, alternative);
      }
      case ExecutableType executable -> {
        collect(into, executable.getReturnType());
        for (TypeMirror parameter : executable.getParameterTypes()) collect(into, parameter);
        for (TypeMirror thrown : executable.getThrownTypes()) collect(into, thrown);
      }
      default -> {}
    }
  }

  // Pass 2: the relations each declaration's code has.
  private final class Relater extends TreePathScanner<Void, Void> {
    private final String path;
    private final CompilationUnitTree unit;
    private final Deque<Integer> declaredStack = new ArrayDeque<>();
    private final Deque<Integer> executing = new ArrayDeque<>();
    // The path each enclosing class maps its methods' routes under.
    private final Deque<String> routePrefixes = new ArrayDeque<>();
    /** The project types this file's code used: every element and type javac attributed. */
    final Set<String> used = new HashSet<>();

    @Override
    public Void scan(Tree tree, Void unused) {
      if (tree != null) {
        TreePath at = new TreePath(getCurrentPath(), tree);
        Element element = p.trees.getElement(at);
        for (Element owner = element; owner != null; owner = owner.getEnclosingElement())
          if (owner instanceof TypeElement type) used.addAll(lineage(type));
        if (element != null && !(element instanceof TypeElement)) collect(used, element.asType());
        collect(used, p.trees.getTypeMirror(at));
      }
      return super.scan(tree, unused);
    }

    Relater(String path, CompilationUnitTree unit) {
      this.path = path;
      this.unit = unit;
      int file = fileObjects.get(path);
      declaredStack.push(file);
      executing.push(file);
    }

    private TreePath child(Tree tree) {
      return new TreePath(getCurrentPath(), tree);
    }

    private Element element(TreePath path) {
      return p.trees.getElement(path);
    }

    // A site's span; a tree the parser made up without an end (an enum constant's implicit
    // constructor call) takes the span of the nearest enclosing tree that has one.
    private Map<String, Object> site(String kind, int from, Tree tree, String target) {
      long start = start(unit, tree);
      long end = end(unit, tree);
      for (TreePath at = getCurrentPath(); (start < 0 || end < start) && at != null; at = at.getParentPath()) {
        start = start(unit, at.getLeaf());
        end = end(unit, at.getLeaf());
      }
      return relation(kind, from, path, start, end, target);
    }

    // Why a call or reference stays unresolved: a JDK member is the platform's; a member of a
    // type javac could not load (a missing dependency) is an unloaded package's; a member of
    // these sources that has no object (a generated one, or one in a file with syntax errors) is
    // unmapped; anything else is a value of unknown type.
    private String reason(Element element, TreePath selectPath) {
      if (element != null && p.local(element)) return "SOURCE_DECLARATION_UNMAPPED";
      if (element != null) {
        Element owner = element.getEnclosingElement();
        // A type javac could not load stands for a missing dependency.
        if (erroneous(element.asType()) || (owner != null && erroneous(owner.asType())))
          return "DECLARATION_NOT_AVAILABLE";
        return p.platform(element) ? "COMPILER_LIBRARY" : "DECLARATION_NOT_AVAILABLE";
      }
      if (selectPath != null && !(selectPath.getLeaf() instanceof MemberSelectTree)) {
        if (erroneous(p.trees.getTypeMirror(selectPath))) return "DECLARATION_NOT_AVAILABLE";
      } else if (selectPath != null && selectPath.getLeaf() instanceof MemberSelectTree member) {
        TypeMirror receiver =
            p.trees.getTypeMirror(new TreePath(selectPath, member.getExpression()));
        // A receiver declared with a type javac could not load (a field, a parameter, a class
        // name) is a missing dependency's value; the result of a call javac could not resolve is
        // a value of unknown type, which may well be one of the project's.
        if (erroneous(receiver))
          return unresolvedResult(new TreePath(selectPath, member.getExpression()))
              ? "SYMBOL_NOT_RESOLVED"
              : "DECLARATION_NOT_AVAILABLE";
        if (receiver instanceof DeclaredType declaredType
            && declaredType.asElement() instanceof TypeElement type) {
          if (p.platform(type)) return "COMPILER_LIBRARY";
          if (incomplete(type)) return "DECLARATION_NOT_AVAILABLE";
        }
        return "SYMBOL_NOT_RESOLVED";
      }
      for (TreePath at = getCurrentPath(); at != null; at = at.getParentPath())
        if (at.getLeaf() instanceof ClassTree
            && p.trees.getElement(at) instanceof TypeElement type
            && incomplete(type)) return "DECLARATION_NOT_AVAILABLE";
      return "SYMBOL_NOT_RESOLVED";
    }

    // Whether an expression is the result of a call javac could not resolve.
    private boolean unresolvedResult(TreePath path) {
      Tree leaf = path.getLeaf();
      if (leaf instanceof ParenthesizedTree group)
        return unresolvedResult(new TreePath(path, group.getExpression()));
      if (!(leaf instanceof MethodInvocationTree)) return leaf instanceof ArrayAccessTree;
      Element called = element(path);
      if (called == null || erroneous(called.asType())) return true;
      Element owner = called.getEnclosingElement();
      return owner != null && erroneous(owner.asType());
    }

    private void link(Map<String, Object> relation, Element element, TreePath selectPath) {
      Integer to = linked(element);
      if (to != null) resolved(relation, to);
      else unresolved(relation, reason(element, selectPath));
    }

    // Decorations of a declaration; a method's (prefix not null) also name the routes they map,
    // joined with the path its class maps under that prefix.
    private void decorations(ModifiersTree modifiers, int owner, String prefix) {
      if (modifiers == null) return;
      TreePath modifiersPath = child(modifiers);
      // JAX-RS names a method's HTTP method in an annotation of its own: @GET beside @Path("{id}").
      List<String> sibling = new ArrayList<>();
      for (AnnotationTree annotation : modifiers.getAnnotations())
        if (HTTP_METHODS.contains(simpleName(annotation))) sibling.add(simpleName(annotation));
      for (AnnotationTree annotation : modifiers.getAnnotations()) {
        if (!p.written(unit, annotation)) continue;
        TreePath annotationPath = new TreePath(modifiersPath, annotation);
        TreePath typePath = new TreePath(annotationPath, annotation.getAnnotationType());
        Element type = element(typePath);
        if (type instanceof TypeElement typeElement
            && HINTS.contains(typeElement.getQualifiedName().toString())) continue;
        Map<String, Object> relation =
            site("DECORATED_BY", owner, annotation, label(annotation.getAnnotationType()));
        String argument = argument(annotationPath, annotation);
        if (argument != null) relation.put("argument", argument);
        String route = prefix == null ? null : route(annotationPath, annotation, argument, prefix, sibling);
        if (route != null && !route.equals(argument)) relation.put("route", route);
        link(relation, type, typePath);
      }
    }

    private static String simpleName(AnnotationTree annotation) {
      String name = label(annotation.getAnnotationType());
      return name.substring(name.lastIndexOf('.') + 1);
    }

    // Route annotations by convention: named for a method (GetMapping), a mapping, or a path.
    private static boolean routeAnnotation(String name) {
      return NAMED_METHOD.matcher(name).find() || name.endsWith("Mapping") || name.equals("Path");
    }

    // The path a class's route annotation maps its methods under, or "" without one.
    private String routePrefix(ModifiersTree modifiers) {
      if (modifiers == null) return "";
      TreePath modifiersPath = child(modifiers);
      for (AnnotationTree annotation : modifiers.getAnnotations()) {
        String argument = argument(new TreePath(modifiersPath, annotation), annotation);
        if (argument != null && (routeAnnotation(simpleName(annotation)) || argument.startsWith("/")))
          return argument;
      }
      return "";
    }

    // The route a method's annotation maps: its HTTP methods, if named, then the class's path
    // joined with its own. Null for annotations that map no route.
    private String route(
        TreePath annotationPath, AnnotationTree annotation, String argument, String prefix, List<String> sibling) {
      String name = simpleName(annotation);
      if (!routeAnnotation(name)) return null;
      List<String> methods = new ArrayList<>();
      java.util.regex.Matcher named = NAMED_METHOD.matcher(name);
      if (named.find()) methods.add(named.group(1).toUpperCase(java.util.Locale.ROOT));
      for (ExpressionTree element : annotation.getArguments())
        if (element instanceof AssignmentTree assignment && label(assignment.getVariable()).equals("method")) {
          ExpressionTree value = assignment.getExpression();
          List<? extends ExpressionTree> values =
              value instanceof NewArrayTree array && array.getInitializers() != null
                  ? array.getInitializers()
                  : List.of(value);
          for (ExpressionTree item : values) {
            String constant = label(item);
            constant = constant.substring(constant.lastIndexOf('.') + 1);
            if (HTTP_METHODS.contains(constant)) methods.add(constant);
          }
        }
      if (methods.isEmpty()) methods.addAll(sibling);
      if (argument == null && prefix.isEmpty() && methods.isEmpty()) return null;
      String path = joinRoute(prefix, argument == null ? "" : argument);
      String route = methods.isEmpty() ? path : String.join("|", methods) + " " + path;
      return route.length() <= 256 ? route : null;
    }

    private static String joinRoute(String prefix, String path) {
      String joined =
          prefix.isEmpty()
              ? path
              : path.isEmpty() ? prefix : prefix.replaceAll("/+$", "") + "/" + path.replaceAll("^/+", "");
      // A property placeholder (${api.base:/api}) is left as written.
      return joined.startsWith("/") || joined.startsWith("$") ? joined : "/" + joined;
    }

    // The literal an annotation is about, usually a route: its value or path, or the first of them.
    private String argument(TreePath annotationPath, AnnotationTree annotation) {
      for (ExpressionTree argument : annotation.getArguments()) {
        ExpressionTree value = argument;
        if (argument instanceof AssignmentTree assignment) {
          String name = label(assignment.getVariable());
          if (!name.equals("value") && !name.equals("path")) continue;
          value = assignment.getExpression();
        }
        TreePath valuePath =
            argument instanceof AssignmentTree assignment
                ? new TreePath(new TreePath(annotationPath, argument), assignment.getExpression())
                : new TreePath(annotationPath, argument);
        if (value instanceof NewArrayTree array) {
          if (array.getInitializers() == null || array.getInitializers().isEmpty()) return null;
          value = array.getInitializers().get(0);
          valuePath = new TreePath(valuePath, value);
        }
        String text = constant(valuePath);
        return text != null && !text.isEmpty() && text.length() <= 256 ? text : null;
      }
      return null;
    }

    // A string constant: a literal, a constant field, or a concatenation of them.
    private String constant(TreePath path) {
      Tree tree = path.getLeaf();
      if (tree instanceof LiteralTree literal)
        return literal.getValue() instanceof String text ? text : null;
      if (tree instanceof ParenthesizedTree group)
        return constant(new TreePath(path, group.getExpression()));
      if (tree instanceof BinaryTree binary && binary.getKind() == Tree.Kind.PLUS) {
        String left = constant(new TreePath(path, binary.getLeftOperand()));
        String right = constant(new TreePath(path, binary.getRightOperand()));
        return left == null || right == null ? null : left + right;
      }
      if (tree instanceof IdentifierTree || tree instanceof MemberSelectTree)
        return element(path) instanceof VariableElement variable
                && variable.getConstantValue() instanceof String text
            ? text
            : null;
      return null;
    }

    private void heritage(ClassTree node, int id) {
      boolean contract = node.getKind() == Tree.Kind.INTERFACE;
      if (node.getExtendsClause() != null) superType("EXTENDS", node.getExtendsClause(), id);
      for (Tree type : node.getImplementsClause())
        superType(contract ? "EXTENDS" : "IMPLEMENTS", type, id);
    }

    private void superType(String kind, Tree type, int id) {
      if (!p.written(unit, type)) return;
      link(site(kind, id, type, label(type)), element(child(type)), child(type));
    }

    @Override
    public Void visitImport(ImportTree node, Void unused) {
      if (!p.written(unit, node)) return null;
      Tree qualified = node.getQualifiedIdentifier();
      String specifier = qualified.toString();
      String kind = p.tests.contains(path) ? "TEST_IMPORTS" : "IMPORTS";
      int file = fileObjects.get(path);
      TreePath qualifiedPath = child(qualified);
      boolean wildcard = specifier.endsWith(".*");
      // The type an import names counts as used though it did not resolve (a static import of a
      // member it lacks, a type with a syntax error): the file is analyzed again when it changes.
      String named = node.isStatic() || wildcard ? specifier.substring(0, specifier.lastIndexOf('.')) : specifier;
      if (projectTypes.contains(named)) used.add(named);
      if (!node.isStatic() && wildcard) {
        String pkg = specifier.substring(0, specifier.length() - 2);
        List<Integer> targets = packages.getOrDefault(pkg, List.of());
        for (int target : targets)
          if (target != file) resolved(site(kind, file, node, specifier), target);
        // An on-demand import of a type's members (import p.Outer.*) names the type's file.
        Integer outer = targets.isEmpty() ? fileOf(p.elements.getTypeElement(pkg)) : null;
        if (outer != null) {
          if (outer != file) resolved(site(kind, file, node, specifier), outer);
        } else if (targets.isEmpty()) {
          var element = p.elements.getPackageElement(pkg);
          unresolved(
              site(kind, file, node, specifier),
              element != null && p.platform(element) ? "COMPILER_LIBRARY" : "DECLARATION_NOT_AVAILABLE");
        }
        return null;
      }
      TreePath typePath =
          node.isStatic() && qualified instanceof MemberSelectTree member
              ? new TreePath(qualifiedPath, member.getExpression())
              : qualifiedPath;
      Element element = element(typePath);
      Integer target = element instanceof TypeElement type ? fileOf(type) : null;
      Map<String, Object> relation = site(kind, file, node, specifier);
      if (target != null) {
        if (target == file) relations.remove(relation);
        else resolved(relation, target);
      } else
        unresolved(
            relation,
            element != null && p.local(element)
                ? "SOURCE_DECLARATION_UNMAPPED"
                : element != null && p.platform(element) ? "COMPILER_LIBRARY" : "DECLARATION_NOT_AVAILABLE");
      return null;
    }

    /** The file object of the source that declares a type (its outermost type), if mapped. */
    private Integer fileOf(TypeElement type) {
      if (type == null) return null;
      Element top = type;
      while (top.getEnclosingElement() instanceof TypeElement outer) top = outer;
      TreePath declaration = p.trees.getPath(top);
      return declaration == null ? null : fileObjects.get(p.paths.get(declaration.getCompilationUnit()));
    }

    @Override
    public Void visitClass(ClassTree node, Void unused) {
      Integer id = trees.get(node);
      if (id == null) return null;
      decorations(node.getModifiers(), id, null);
      heritage(node, id);
      declaredStack.push(id);
      executing.push(id);
      routePrefixes.push(routePrefix(node.getModifiers()));
      try {
        return super.visitClass(node, unused);
      } finally {
        declaredStack.pop();
        executing.pop();
        routePrefixes.pop();
      }
    }

    @Override
    public Void visitMethod(MethodTree node, Void unused) {
      Integer id = trees.get(node);
      if (id == null) return null;
      decorations(node.getModifiers(), id, routePrefixes.isEmpty() ? "" : routePrefixes.peek());
      declaredStack.push(id);
      executing.push(id);
      try {
        return super.visitMethod(node, unused);
      } finally {
        declaredStack.pop();
        executing.pop();
      }
    }

    @Override
    public Void visitVariable(VariableTree node, Void unused) {
      Integer id = trees.get(node);
      if (id == null) {
        if (getCurrentPath().getParentPath().getLeaf() instanceof ClassTree) return null;
        return super.visitVariable(node, unused);
      }
      decorations(node.getModifiers(), id, null);
      declaredStack.push(id);
      executing.push(id);
      try {
        return super.visitVariable(node, unused);
      } finally {
        declaredStack.pop();
        executing.pop();
      }
    }

    @Override
    public Void visitBlock(BlockTree node, Void unused) {
      Integer id = trees.get(node);
      if (id == null) return super.visitBlock(node, unused);
      declaredStack.push(id);
      executing.push(id);
      try {
        return super.visitBlock(node, unused);
      } finally {
        declaredStack.pop();
        executing.pop();
      }
    }

    @Override
    public Void visitLambdaExpression(LambdaExpressionTree node, Void unused) {
      Integer id = trees.get(node);
      if (id == null) return super.visitLambdaExpression(node, unused);
      dispatch(node, id);
      declaredStack.push(id);
      executing.push(id);
      try {
        return super.visitLambdaExpression(node, unused);
      } finally {
        declaredStack.pop();
        executing.pop();
      }
    }

    // A lambda implements the single abstract method of the interface it is passed as, so a call
    // through that method may reach it.
    private void dispatch(LambdaExpressionTree node, int id) {
      if (!(p.trees.getTypeMirror(getCurrentPath()) instanceof DeclaredType type)
          || !(type.asElement() instanceof TypeElement contract)
          || !declared.containsKey(contract)) return;
      Integer method = null;
      for (Element member : p.elements.getAllMembers(contract))
        if (member.getKind() == ElementKind.METHOD
            && member.getModifiers().contains(Modifier.ABSTRACT)
            && declared.containsKey(member)) {
          if (method != null) return;
          method = declared.get(member);
        }
      if (method == null) return;
      long start = start(unit, node);
      long end = node.getBody() == null ? end(unit, node) : start(unit, node.getBody());
      resolved(relation("OVERRIDES", id, path, start, Math.max(start, end), "<lambda>"), method);
    }

    @Override
    public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
      if (p.written(unit, node)) {
        Map<String, Object> relation =
            site("CALLS", executing.peek(), node, label(node.getMethodSelect()));
        link(relation, element(getCurrentPath()), child(node.getMethodSelect()));
      }
      return super.visitMethodInvocation(node, unused);
    }

    @Override
    public Void visitNewClass(NewClassTree node, Void unused) {
      if (p.written(unit, node)) {
        Map<String, Object> relation =
            site("CALLS", executing.peek(), node, label(node.getIdentifier()));
        link(relation, element(getCurrentPath()), child(node.getIdentifier()));
      }
      return super.visitNewClass(node, unused);
    }

    // A try-with-resources statement calls each resource's close() when the block ends.
    @Override
    public Void visitTry(TryTree node, Void unused) {
      for (Tree resource : node.getResources()) {
        if (!p.written(unit, resource)) continue;
        Integer to = closer(p.trees.getTypeMirror(child(resource)));
        String name =
            resource instanceof VariableTree variable ? variable.getName().toString() : label(resource);
        if (to != null) resolved(site("CALLS", executing.peek(), resource, name + ".close"), to);
      }
      return super.visitTry(node, unused);
    }

    // The project's close() a resource of this type runs: the nearest one up its supertypes.
    private Integer closer(TypeMirror type) {
      if (type == null) return null;
      Deque<TypeMirror> pending = new ArrayDeque<>(List.of(type));
      Set<Element> seen = new HashSet<>();
      while (!pending.isEmpty()) {
        if (!(pending.poll() instanceof DeclaredType current)
            || !(current.asElement() instanceof TypeElement element)
            || !seen.add(element)) continue;
        for (Element member : element.getEnclosedElements())
          if (member.getKind() == ElementKind.METHOD
              && member.getSimpleName().contentEquals("close")
              && ((ExecutableElement) member).getParameters().isEmpty())
            return declared.get(member);
        pending.addAll(p.types.directSupertypes(current));
      }
      return null;
    }

    @Override
    public Void visitMemberReference(MemberReferenceTree node, Void unused) {
      if (p.written(unit, node)) {
        Integer to = linked(element(getCurrentPath()));
        if (to != null)
          resolved(
              site("REFERENCES", declaredStack.peek(), node, label(node.getQualifierExpression()) + "::" + node.getName()),
              to);
      }
      return super.visitMemberReference(node, unused);
    }

    // Targets of assignments: a write there, not a read.
    private final Set<Tree> writing = java.util.Collections.newSetFromMap(new IdentityHashMap<>());

    @Override
    public Void visitIdentifier(IdentifierTree node, Void unused) {
      staticRead(node);
      return super.visitIdentifier(node, unused);
    }

    @Override
    public Void visitMemberSelect(MemberSelectTree node, Void unused) {
      staticRead(node);
      return super.visitMemberSelect(node, unused);
    }

    // A read of a project's static field: a change to its value changes what the reader does.
    private void staticRead(ExpressionTree node) {
      if (writing.contains(node) || !p.written(unit, node)) return;
      Element element = element(getCurrentPath());
      if (element == null
          || element.getKind() != ElementKind.FIELD
          || !element.getModifiers().contains(Modifier.STATIC)) return;
      Integer to = declared.get(element);
      if (to != null) resolved(site("REFERENCES", declaredStack.peek(), node, label(node)), to);
    }

    private void write(ExpressionTree target) {
      writing.add(target);
      if (!p.written(unit, target)) return;
      Element element = element(child(target));
      if (element == null || !element.getKind().isField()) return;
      link(site("WRITES", executing.peek(), target, label(target)), element, null);
    }

    @Override
    public Void visitAssignment(AssignmentTree node, Void unused) {
      write(node.getVariable());
      return super.visitAssignment(node, unused);
    }

    @Override
    public Void visitCompoundAssignment(CompoundAssignmentTree node, Void unused) {
      write(node.getVariable());
      return super.visitCompoundAssignment(node, unused);
    }

    @Override
    public Void visitUnary(UnaryTree node, Void unused) {
      switch (node.getKind()) {
        case PREFIX_INCREMENT, PREFIX_DECREMENT, POSTFIX_INCREMENT, POSTFIX_DECREMENT ->
            write(node.getExpression());
        default -> {}
      }
      return super.visitUnary(node, unused);
    }
  }
}
