package javamap;

import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.CompoundAssignmentTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MemberReferenceTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.UnaryTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;

/** Every site in the program that refers to the declarations named at given positions. */
final class References {
  private final Program p;

  References(Program program) {
    this.p = program;
  }

  /** A page for each target, in one scan of the program; null where it names no declaration. */
  Map<String, Object> find(List<?> targets) {
    Map<Element, List<Map<String, Object>>> wanted = new HashMap<>();
    List<Object> pages = new ArrayList<>();
    for (Object value : targets) {
      Map<String, Object> target = Requests.object(value);
      String path = Requests.string(target, "path");
      int offset = Requests.integer(target, "offset", -1);
      CompilationUnitTree unit = p.units.get(path);
      Element element = unit == null || offset < 0 ? null : declarationAt(unit, offset);
      pages.add(
          element == null
              ? null
              : Extract.fact(
                  "references", wanted.computeIfAbsent(element, key -> new ArrayList<>())));
    }
    for (Map.Entry<String, CompilationUnitTree> entry : p.units.entrySet())
      new Collector(entry.getKey(), entry.getValue(), wanted).scan(entry.getValue(), null);
    return Extract.fact("pages", pages);
  }

  // The declaration whose name starts at the offset (the map's symbol start).
  private Element declarationAt(CompilationUnitTree unit, int offset) {
    String text = p.texts.get(p.paths.get(unit));
    Element[] found = {null};
    new TreePathScanner<Void, Void>() {
      private void check(Tree tree, String name) {
        if (found[0] != null || name.isEmpty()) return;
        if (offset + name.length() > text.length()
            || !text.startsWith(name, offset)
            || offset < p.positions.getStartPosition(unit, tree)
            || offset >= p.positions.getEndPosition(unit, tree)) return;
        found[0] = p.trees.getElement(getCurrentPath());
      }

      @Override
      public Void visitClass(ClassTree node, Void unused) {
        check(node, node.getSimpleName().toString());
        return super.visitClass(node, unused);
      }

      @Override
      public Void visitMethod(MethodTree node, Void unused) {
        String name = node.getReturnType() == null ? enclosingName() : node.getName().toString();
        check(node, name);
        return super.visitMethod(node, unused);
      }

      @Override
      public Void visitVariable(VariableTree node, Void unused) {
        check(node, node.getName().toString());
        return super.visitVariable(node, unused);
      }

      private String enclosingName() {
        for (TreePath at = getCurrentPath(); at != null; at = at.getParentPath())
          if (at.getLeaf() instanceof ClassTree type) return type.getSimpleName().toString();
        return "";
      }
    }.scan(unit, null);
    return found[0];
  }

  private final class Collector extends TreePathScanner<Void, Void> {
    private final String path;
    private final CompilationUnitTree unit;
    private final Map<Element, List<Map<String, Object>>> wanted;
    private final String text;

    Collector(String path, CompilationUnitTree unit, Map<Element, List<Map<String, Object>>> wanted) {
      this.path = path;
      this.unit = unit;
      this.wanted = wanted;
      this.text = p.texts.get(path);
    }

    private void add(Element element, long start, long end, String kind) {
      if (start < 0 || end < start) return;
      wanted.get(element).add(Extract.fact("path", path, "start", start, "end", end, "kind", kind));
    }

    // The span of a name inside a tree: the last occurrence of the identifier in it.
    private void name(Element element, Tree tree, String name, String kind) {
      long start = p.positions.getStartPosition(unit, tree);
      long end = p.positions.getEndPosition(unit, tree);
      if (start < 0 || end < 0 || end > text.length()) return;
      int at = text.lastIndexOf(name, (int) end - name.length());
      if (at < start) at = text.indexOf(name, (int) start);
      if (at >= start && at + name.length() <= end) add(element, at, at + name.length(), kind);
    }

    // The target the current tree refers to, if it does.
    private Element target() {
      Element element = p.trees.getElement(getCurrentPath());
      return element != null && wanted.containsKey(element) ? element : null;
    }

    private String usage(TreePath path, Element target) {
      Tree parent = path.getParentPath() == null ? null : path.getParentPath().getLeaf();
      Tree leaf = path.getLeaf();
      if (parent instanceof MethodInvocationTree call && call.getMethodSelect() == leaf) return "CALL";
      if (parent instanceof AssignmentTree assignment && assignment.getVariable() == leaf) return "WRITE";
      if (parent instanceof CompoundAssignmentTree compound && compound.getVariable() == leaf)
        return "WRITE";
      if (parent instanceof UnaryTree) return "WRITE";
      for (TreePath at = path; at != null; at = at.getParentPath())
        if (at.getLeaf() instanceof ImportTree) return "IMPORT_EXPORT";
      return target.getKind().isField() || target.getKind() == ElementKind.LOCAL_VARIABLE
          ? "READ"
          : "REFERENCE";
    }

    @Override
    public Void visitClass(ClassTree node, Void unused) {
      if (!p.written(unit, node)) return null;
      Element target = target();
      if (target != null) name(target, node, node.getSimpleName().toString(), "DECLARATION");
      return super.visitClass(node, unused);
    }

    @Override
    public Void visitMethod(MethodTree node, Void unused) {
      if (!p.written(unit, node)) return null;
      Element target = target();
      if (target != null) {
        long start = p.positions.getStartPosition(unit, node);
        String name =
            node.getReturnType() == null ? target.getEnclosingElement().getSimpleName().toString() : node.getName().toString();
        int at = text.indexOf(name + "(", (int) start);
        if (at < 0) at = text.indexOf(name, (int) start);
        if (at >= 0) add(target, at, at + name.length(), "DECLARATION");
      }
      return super.visitMethod(node, unused);
    }

    @Override
    public Void visitVariable(VariableTree node, Void unused) {
      Element target = p.written(unit, node) ? target() : null;
      if (target != null) name(target, node, node.getName().toString(), "DECLARATION");
      return super.visitVariable(node, unused);
    }

    @Override
    public Void visitIdentifier(IdentifierTree node, Void unused) {
      Element target = p.written(unit, node) ? target() : null;
      if (target != null)
        add(
            target,
            p.positions.getStartPosition(unit, node),
            p.positions.getEndPosition(unit, node),
            usage(getCurrentPath(), target));
      return super.visitIdentifier(node, unused);
    }

    @Override
    public Void visitMemberSelect(MemberSelectTree node, Void unused) {
      Element target = p.written(unit, node) ? target() : null;
      if (target != null) {
        long end = p.positions.getEndPosition(unit, node);
        add(target, end - node.getIdentifier().length(), end, usage(getCurrentPath(), target));
      }
      return super.visitMemberSelect(node, unused);
    }

    @Override
    public Void visitNewClass(NewClassTree node, Void unused) {
      Element target = p.written(unit, node) ? target() : null;
      if (target != null) {
        Tree identifier = node.getIdentifier();
        add(
            target,
            p.positions.getStartPosition(unit, identifier),
            p.positions.getEndPosition(unit, identifier),
            "CALL");
      }
      return super.visitNewClass(node, unused);
    }

    @Override
    public Void visitMemberReference(MemberReferenceTree node, Void unused) {
      Element target = p.written(unit, node) ? target() : null;
      if (target != null) {
        long end = p.positions.getEndPosition(unit, node);
        add(target, end - node.getName().length(), end, "REFERENCE");
      }
      return super.visitMemberReference(node, unused);
    }
  }
}
