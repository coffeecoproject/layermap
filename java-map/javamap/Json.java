package javamap;

import java.io.IOException;
import java.io.Writer;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The JSON of one request and one result: objects, arrays, strings, numbers, booleans, null. */
final class Json {
  private final String text;
  private int at;

  private Json(String text) {
    this.text = text;
  }

  static Object parse(String text) {
    Json json = new Json(text);
    json.space();
    Object value = json.value();
    json.space();
    if (json.at != text.length()) throw json.error();
    return value;
  }

  private IllegalArgumentException error() {
    return new IllegalArgumentException("invalid JSON at " + at);
  }

  private void space() {
    while (at < text.length() && " \t\r\n".indexOf(text.charAt(at)) >= 0) at++;
  }

  private boolean next(char expected) {
    if (at < text.length() && text.charAt(at) == expected) {
      at++;
      return true;
    }
    return false;
  }

  private void expect(char expected) {
    if (!next(expected)) throw error();
  }

  private Object value() {
    if (at >= text.length()) throw error();
    return switch (text.charAt(at)) {
      case '{' -> object();
      case '[' -> array();
      case '"' -> string();
      case 't' -> literal("true", Boolean.TRUE);
      case 'f' -> literal("false", Boolean.FALSE);
      case 'n' -> literal("null", null);
      default -> number();
    };
  }

  private Object literal(String word, Object value) {
    if (!text.startsWith(word, at)) throw error();
    at += word.length();
    return value;
  }

  private Map<String, Object> object() {
    Map<String, Object> map = new LinkedHashMap<>();
    expect('{');
    space();
    if (next('}')) return map;
    do {
      space();
      if (at >= text.length() || text.charAt(at) != '"') throw error();
      String key = string();
      space();
      expect(':');
      space();
      map.put(key, value());
      space();
    } while (next(','));
    expect('}');
    return map;
  }

  private List<Object> array() {
    List<Object> list = new ArrayList<>();
    expect('[');
    space();
    if (next(']')) return list;
    do {
      space();
      list.add(value());
      space();
    } while (next(','));
    expect(']');
    return list;
  }

  private String string() {
    expect('"');
    StringBuilder out = new StringBuilder();
    while (true) {
      int stop = at;
      while (stop < text.length() && text.charAt(stop) != '"' && text.charAt(stop) != '\\') stop++;
      if (stop >= text.length()) throw error();
      out.append(text, at, stop);
      at = stop + 1;
      if (text.charAt(stop) == '"') return out.toString();
      if (at >= text.length()) throw error();
      char escape = text.charAt(at++);
      switch (escape) {
        case '"', '\\', '/' -> out.append(escape);
        case 'b' -> out.append('\b');
        case 'f' -> out.append('\f');
        case 'n' -> out.append('\n');
        case 'r' -> out.append('\r');
        case 't' -> out.append('\t');
        case 'u' -> {
          if (at + 4 > text.length()) throw error();
          out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
          at += 4;
        }
        default -> throw error();
      }
    }
  }

  private Number number() {
    int start = at;
    while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
    String digits = text.substring(start, at);
    if (digits.isEmpty()) throw error();
    // Not a conditional expression: that would widen the long to a double.
    if (digits.matches("-?\\d+")) return Long.parseLong(digits);
    return Double.parseDouble(digits);
  }

  static void write(Object value, Writer out) throws IOException {
    if (value == null) out.write("null");
    else if (value instanceof String string) quote(string, out);
    else if (value instanceof Number || value instanceof Boolean) out.write(value.toString());
    else if (value instanceof Map<?, ?> map) {
      out.write('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (entry.getValue() == null) continue;
        if (!first) out.write(',');
        first = false;
        quote(String.valueOf(entry.getKey()), out);
        out.write(':');
        write(entry.getValue(), out);
      }
      out.write('}');
    } else if (value instanceof Collection<?> list) {
      out.write('[');
      boolean first = true;
      for (Object item : list) {
        if (!first) out.write(',');
        first = false;
        write(item, out);
      }
      out.write(']');
    } else throw new IllegalArgumentException("cannot write " + value.getClass());
  }

  // Control characters and surrogates are escaped, so a lone surrogate survives as text.
  private static void quote(String text, Writer out) throws IOException {
    out.write('"');
    for (int index = 0; index < text.length(); index++) {
      char c = text.charAt(index);
      if (c == '"' || c == '\\') {
        out.write('\\');
        out.write(c);
      } else if (c < 0x20 || Character.isSurrogate(c)) out.write(String.format("\\u%04x", (int) c));
      else out.write(c);
    }
    out.write('"');
  }
}
