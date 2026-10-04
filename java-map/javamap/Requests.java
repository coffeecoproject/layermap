package javamap;

import java.util.List;
import java.util.Map;

/** Typed reads of the request's JSON values; a missing or mistyped field is a protocol error. */
final class Requests {
  private Requests() {}

  private static Main.Failure invalid(String field) {
    return new Main.Failure("PROJECT_MAP_PROTOCOL_INVALID", "invalid field " + field);
  }

  @SuppressWarnings("unchecked")
  static Map<String, Object> object(Object value) {
    if (value instanceof Map<?, ?> map) return (Map<String, Object>) map;
    throw invalid("object");
  }

  static String string(Map<String, Object> request, String field) {
    if (request.get(field) instanceof String value) return value;
    throw invalid(field);
  }

  static String optionalString(Map<String, Object> request, String field) {
    Object value = request.get(field);
    if (value == null || value instanceof String) return (String) value;
    throw invalid(field);
  }

  static int integer(Map<String, Object> request, String field, int fallback) {
    Object value = request.get(field);
    if (value == null) return fallback;
    if (value instanceof Long number && number >= 0 && number <= Integer.MAX_VALUE)
      return number.intValue();
    throw invalid(field);
  }

  static List<?> list(Map<String, Object> request, String field) {
    Object value = request.get(field);
    if (value == null) return List.of();
    if (value instanceof List<?> list) return list;
    throw invalid(field);
  }
}
