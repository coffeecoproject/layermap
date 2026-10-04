package javamap;

import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.util.TreePath;
import com.sun.source.util.Trees;
import java.io.IOException;
import java.lang.annotation.Annotation;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.Set;
import javax.annotation.processing.Completion;
import javax.annotation.processing.ProcessingEnvironment;
import javax.annotation.processing.Processor;
import javax.annotation.processing.RoundEnvironment;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.AnnotationMirror;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;

/**
 * One of Lombok's annotation processors, shown only the classes of files that name Lombok. Lombok
 * walks the whole tree of every class it is shown at each of its handler priorities; a file that
 * never names it has nothing for it to generate, and those walks were most of entering the
 * sources of a project where few files use it.
 */
final class LombokRoots implements Processor {
  /** The processors the Lombok jar declares, each wrapped. */
  static List<Processor> load(String jar) throws IOException {
    ClassLoader loader =
        new URLClassLoader(new URL[] {Path.of(jar).toUri().toURL()}, Program.class.getClassLoader());
    List<Processor> processors = new ArrayList<>();
    for (Processor processor : ServiceLoader.load(Processor.class, loader))
      processors.add(new LombokRoots(processor));
    if (processors.isEmpty())
      throw new Main.Failure("PROJECT_MAP_ANALYSIS_FAILED", "no annotation processor in " + jar);
    return processors;
  }

  private final Processor lombok;
  private final Map<CompilationUnitTree, Boolean> names = new IdentityHashMap<>();
  private Trees trees;

  private LombokRoots(Processor lombok) {
    this.lombok = lombok;
  }

  /** Whether the file declaring an element names Lombok; an element without a tree is kept. */
  private boolean shown(Element element) {
    TreePath path = trees.getPath(element);
    if (path == null) return true;
    return names.computeIfAbsent(
        path.getCompilationUnit(),
        unit -> {
          try {
            return unit.getSourceFile().getCharContent(true).toString().contains("lombok.");
          } catch (IOException error) {
            return true;
          }
        });
  }

  private Set<? extends Element> shown(Set<? extends Element> elements) {
    Set<Element> kept = new LinkedHashSet<>();
    for (Element element : elements) if (shown(element)) kept.add(element);
    return kept;
  }

  @Override
  public void init(ProcessingEnvironment environment) {
    trees = Trees.instance(environment);
    lombok.init(environment);
  }

  @Override
  public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment round) {
    return lombok.process(
        annotations,
        new RoundEnvironment() {
          @Override
          public boolean processingOver() {
            return round.processingOver();
          }

          @Override
          public boolean errorRaised() {
            return round.errorRaised();
          }

          @Override
          public Set<? extends Element> getRootElements() {
            return shown(round.getRootElements());
          }

          @Override
          public Set<? extends Element> getElementsAnnotatedWith(TypeElement annotation) {
            return shown(round.getElementsAnnotatedWith(annotation));
          }

          @Override
          public Set<? extends Element> getElementsAnnotatedWith(Class<? extends Annotation> annotation) {
            return shown(round.getElementsAnnotatedWith(annotation));
          }
        });
  }

  @Override
  public Set<String> getSupportedOptions() {
    return lombok.getSupportedOptions();
  }

  @Override
  public Set<String> getSupportedAnnotationTypes() {
    return lombok.getSupportedAnnotationTypes();
  }

  @Override
  public SourceVersion getSupportedSourceVersion() {
    return lombok.getSupportedSourceVersion();
  }

  @Override
  public Iterable<? extends Completion> getCompletions(
      Element element, AnnotationMirror annotation, ExecutableElement member, String text) {
    return lombok.getCompletions(element, annotation, member, text);
  }
}
