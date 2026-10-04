package javamap;

import java.io.BufferedWriter;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * The Java analyzer of LayerMap.
 *
 * <p>It reads one JSON request on stdin and writes one JSON result on stdout. It never reads
 * project files and never uses the network: every source comes from the request; the only file
 * it opens is the Lombok jar the request names, which runs as javac's annotation processor.
 * Positions are offsets into the request's text in UTF-16 code units (Java's own chars).
 */
public final class Main {
  /** A stable failure code the relay worker reports. */
  static final class Failure extends RuntimeException {
    private static final long serialVersionUID = 1L;
    final String code;

    Failure(String code, String detail) {
      super(detail);
      this.code = code;
    }
  }

  private static final boolean TIMING = Boolean.getBoolean("javamap.timing");
  private static long last = System.nanoTime();

  /** With -Djavamap.timing=true, the time each phase took, on stderr. */
  static void time(String phase) {
    if (!TIMING) return;
    long now = System.nanoTime();
    System.err.println("timing " + phase + " " + (now - last) / 1_000_000 + " ms");
    last = now;
  }

  public static void main(String[] args) {
    Map<String, Object> request;
    try {
      String input = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
      request = Requests.object(Json.parse(input));
    } catch (Exception error) {
      fail("PROJECT_MAP_PROTOCOL_INVALID", error);
      return;
    }
    try {
      Program program = Program.load(request);
      Object output =
          switch (Requests.string(request, "operation")) {
            case "BUILD" -> {
              Object facts = new Extract(program).run();
              time("extract");
              yield facts;
            }
            case "REFERENCES" -> new References(program).find(Requests.object(request.get("target")));
            default -> throw new Failure("PROJECT_MAP_PROTOCOL_INVALID", "unknown operation");
          };
      Writer out =
          new BufferedWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), 1 << 16);
      Json.write(output, out);
      out.write('\n');
      out.flush();
    } catch (Failure failure) {
      fail(failure.code, failure);
    } catch (OutOfMemoryError error) {
      fail("PROJECT_MAP_ANALYSIS_FAILED", error);
    } catch (Exception error) {
      fail("PROJECT_MAP_ANALYSIS_FAILED", error);
    }
  }

  // The first stderr line is the code; the worker turns it into a map failure.
  private static void fail(String code, Throwable error) {
    System.err.println(code);
    System.err.println(error);
    System.exit(2);
  }
}
