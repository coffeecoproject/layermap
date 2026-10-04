package javamap;

import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.TreePath;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.TypeParameterElement;
import javax.lang.model.element.VariableElement;

/**
 * What one build of a context leaves for the next: a digest of each type's interface (its kind,
 * modifiers, supertypes and members in order, Lombok's included, with constant values) and, for
 * each file, the project types its attribution used, its errors, package and on-demand imports.
 *
 * <p>A later build attributes a file again when its text changed, a type it used or imported
 * changed, it names a type that appeared or disappeared, it had errors and names a type that
 * changed, or it imports on demand a package whose files changed. Any other file's facts and errors are the previous build's: they depend only on its
 * text and the types it used.
 */
final class Increment {
  /** The format of the record; a build given another attributes every file. */
  private static final long VERSION = 2;
  /** Each type's digest by "path#qualified name". */
  private final Map<String, String> digests = new TreeMap<>();
  /** The qualified name of each type the sources declare as a member of a package or type. */
  final Map<TypeElement, String> types = new IdentityHashMap<>();
  private final Map<String, String> packages = new HashMap<>();
  private final Map<String, List<String>> onDemand = new HashMap<>();
  /** The previous build's record, for an incremental build. */
  private final Map<String, Object> previous;
  private final List<?> previousNames;
  private final Map<String, Object> previousFiles;
  private final Set<String> changed = new HashSet<>();
  /** The program's errors, the previous build's for files not attributed again; set by state. */
  long typeErrors;

  private Increment(Map<String, Object> incremental) {
    if (incremental == null) {
      previous = null;
      previousNames = List.of();
      previousFiles = Map.of();
      return;
    }
    previous = Requests.object(incremental.get("state"));
    previousNames = Requests.list(previous, "names");
    previousFiles = Requests.object(previous.get("files"));
    for (Object path : Requests.list(incremental, "changed")) changed.add(String.valueOf(path));
  }

  /** Whether an incremental request carries a record of this format that this build can read. */
  static boolean usable(Object value) {
    if (!(value instanceof Map<?, ?> incremental)
        || !(incremental.get("changed") instanceof List<?> changed)
        || !(incremental.get("state") instanceof Map<?, ?> state)
        || !(state.get("version") instanceof Long version)
        || version != VERSION
        || !(state.get("types") instanceof Map<?, ?> types)
        || !(state.get("names") instanceof List<?> names)
        || !(state.get("files") instanceof Map<?, ?> files)
        || !(state.get("orphan") == null || state.get("orphan") instanceof Long)) return false;
    for (Object path : changed) if (!(path instanceof String)) return false;
    for (Object digest : types.values()) if (!(digest instanceof String)) return false;
    for (Object name : names) if (!(name instanceof String)) return false;
    for (Object entry : files.values()) {
      if (!(entry instanceof Map<?, ?> file)
          || !(file.get("p") instanceof String)
          || !(file.get("u") instanceof List<?> uses)
          || !(file.get("w") == null || file.get("w") instanceof List<?>)
          || !(file.get("e") == null
              || file.get("e") instanceof Long errors && errors > 0 && errors <= Integer.MAX_VALUE))
        return false;
      for (Object index : uses)
        if (!(index instanceof Long at) || at < 0 || at >= names.size()) return false;
    }
    return true;
  }

  /** Describes the program's types; every class must have been entered. */
  static Increment of(Program p, Map<String, Object> incremental) {
    Increment increment = new Increment(incremental);
    for (Map.Entry<String, CompilationUnitTree> entry : p.units.entrySet()) {
      String path = entry.getKey();
      CompilationUnitTree unit = entry.getValue();
      increment.packages.put(path, unit.getPackageName() == null ? "" : unit.getPackageName().toString());
      List<String> packages = new ArrayList<>();
      for (ImportTree tree : unit.getImports()) {
        String name = tree.getQualifiedIdentifier().toString();
        if (!tree.isStatic() && name.endsWith(".*")) packages.add(name.substring(0, name.length() - 2));
      }
      increment.onDemand.put(path, packages);
      TreePath root = new TreePath(unit);
      for (Tree declaration : unit.getTypeDecls())
        if (p.trees.getElement(new TreePath(root, declaration)) instanceof TypeElement type)
          increment.describe(path, type, p.syntaxErrors.contains(path));
    }
    return increment;
  }

  private void describe(String path, TypeElement type, boolean syntaxError) {
    // A file with a syntax error has no facts, so links into it change when it gets or loses one.
    StringBuilder text = new StringBuilder(syntaxError ? "syntax error\n" : "");
    text.append(type.getKind()).append(' ').append(new TreeSet<>(type.getModifiers()));
    parameters(text, type.getTypeParameters());
    text.append(" extends ").append(type.getSuperclass());
    text.append(" implements ").append(type.getInterfaces());
    text.append(" permits ").append(type.getPermittedSubclasses()).append('\n');
    for (Element member : type.getEnclosedElements()) {
      text.append(member.getKind()).append(' ').append(member.getSimpleName()).append(' ');
      text.append(new TreeSet<>(member.getModifiers()));
      switch (member) {
        case TypeElement nested -> {
          text.append(' ').append(nested.getQualifiedName());
          describe(path, nested, syntaxError);
        }
        case ExecutableElement method -> {
          parameters(text, method.getTypeParameters());
          text.append(' ').append(method.asType()).append(" throws ").append(method.getThrownTypes());
          if (method.isVarArgs()) text.append(" varargs");
          if (method.getDefaultValue() != null) text.append(" default ").append(method.getDefaultValue());
        }
        case VariableElement field -> {
          text.append(' ').append(field.asType());
          Object value = field.getConstantValue();
          if (value instanceof String string) text.append(" = ").append(string.length()).append(':').append(string);
          else if (value != null) text.append(" = ").append(value);
        }
        default -> text.append(' ').append(member.asType());
      }
      text.append('\n');
    }
    String name = type.getQualifiedName().toString();
    types.put(type, name);
    digests.put(path + "#" + name, digest(text.toString()));
  }

  private static void parameters(StringBuilder text, List<? extends TypeParameterElement> parameters) {
    for (TypeParameterElement parameter : parameters)
      text.append(" <").append(parameter.getSimpleName()).append(" extends ").append(parameter.getBounds()).append('>');
  }

  private static String digest(String text) {
    try {
      byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(hash, 0, 8);
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  /** The files an incremental build attributes, or null for all of them. */
  Set<String> attributed(Program p) {
    if (Requests.integer(previous, "orphan", 0) > 0) return null;
    Map<String, Object> before = Requests.object(previous.get("types"));
    Set<String> changedTypes = new HashSet<>();
    // Simple names of types that appeared or disappeared: a file naming one may now resolve it
    // differently, though it used no type that changed.
    Set<String> named = new HashSet<>();
    Set<String> keys = new HashSet<>(before.keySet());
    keys.addAll(digests.keySet());
    // Simple names of every changed type: a file with errors may name one it could not resolve.
    Set<String> changedNames = new HashSet<>();
    for (String key : keys) {
      String after = digests.get(key);
      if (after != null && after.equals(before.get(key))) continue;
      String name = key.substring(key.indexOf('#') + 1);
      String simple = name.substring(name.lastIndexOf('.') + 1);
      changedTypes.add(name);
      changedNames.add(simple);
      if (after == null || before.get(key) == null) named.add(simple);
    }
    // Packages that gained or lost a file with facts: an on-demand import links to their files.
    Set<String> changedPackages = new HashSet<>();
    for (Map.Entry<String, Object> entry : previousFiles.entrySet()) {
      Map<String, Object> file = Requests.object(entry.getValue());
      String path = entry.getKey();
      String after = packages.get(path);
      if (after != null
          && after.equals(file.get("p"))
          && (file.get("s") != null) == p.syntaxErrors.contains(path)) continue;
      changedPackages.add(String.valueOf(file.get("p")));
      if (after != null) changedPackages.add(after);
    }
    for (String path : p.units.keySet())
      if (!previousFiles.containsKey(path)) changedPackages.add(packages.get(path));
    Set<String> attributed = new TreeSet<>();
    for (String path : p.units.keySet()) {
      if (changed.contains(path) || !previousFiles.containsKey(path)) {
        attributed.add(path);
        continue;
      }
      Map<String, Object> file = Requests.object(previousFiles.get(path));
      boolean affected = false;
      for (Object index : Requests.list(file, "u"))
        if (changedTypes.contains(previousName(index))) {
          affected = true;
          break;
        }
      if (!affected)
        for (String name : onDemand.get(path))
          if (changedPackages.contains(name)) {
            affected = true;
            break;
          }
      if (affected
          || (!named.isEmpty() && mentions(p.texts.get(path), named))
          || (Requests.integer(file, "e", 0) > 0
              && !changedNames.isEmpty()
              && mentions(p.texts.get(path), changedNames))) attributed.add(path);
    }
    return attributed.size() == p.units.size() ? null : attributed;
  }

  private String previousName(Object index) {
    if (index instanceof Long value && value >= 0 && value < previousNames.size())
      return String.valueOf(previousNames.get(value.intValue()));
    throw new Main.Failure("PROJECT_MAP_PROTOCOL_INVALID", "invalid field u");
  }

  private static boolean mentions(String text, Set<String> names) {
    for (int at = 0; at < text.length(); ) {
      if (!Character.isJavaIdentifierStart(text.charAt(at))) {
        at++;
        continue;
      }
      int start = at;
      while (at < text.length() && Character.isJavaIdentifierPart(text.charAt(at))) at++;
      if (names.contains(text.substring(start, at))) return true;
    }
    return false;
  }

  /**
   * The record for the next build: uses and errors of the attributed files from this build, the
   * previous build's for the others.
   */
  Map<String, Object> state(Program p, Map<String, Set<String>> uses) {
    List<String> names = new ArrayList<>();
    Map<String, Integer> indexes = new HashMap<>();
    Map<String, Object> files = new TreeMap<>();
    long errors = p.orphanErrors;
    for (String path : p.units.keySet()) {
      Set<String> used = new TreeSet<>();
      long count;
      if (p.attributed(path)) {
        used.addAll(uses.getOrDefault(path, Set.of()));
        count = p.errors.getOrDefault(path, 0);
      } else {
        Map<String, Object> file = Requests.object(previousFiles.get(path));
        for (Object index : Requests.list(file, "u")) used.add(previousName(index));
        count = Requests.integer(file, "e", 0);
      }
      errors += count;
      List<Integer> indices = new ArrayList<>();
      for (String name : used)
        indices.add(
            indexes.computeIfAbsent(
                name,
                key -> {
                  names.add(key);
                  return names.size() - 1;
                }));
      files.put(
          path,
          Extract.fact(
              "p", packages.get(path),
              "w", onDemand.get(path).isEmpty() ? null : onDemand.get(path),
              "u", indices,
              "e", count > 0 ? count : null,
              "s", p.syntaxErrors.contains(path) ? 1 : null));
    }
    typeErrors = errors;
    return Extract.fact(
        "version", VERSION, "types", digests, "names", names, "files", files,
        "orphan", p.orphanErrors > 0 ? p.orphanErrors : null);
  }
}
