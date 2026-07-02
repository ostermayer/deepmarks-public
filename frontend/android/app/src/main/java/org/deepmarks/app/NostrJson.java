package org.deepmarks.app;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class NostrJson {
    private NostrJson() {}

    @SuppressWarnings("unchecked")
    static Map<String, Object> parseObject(String json) {
        Object parsed = parse(json);
        if (!(parsed instanceof Map)) throw new IllegalArgumentException("json root must be an object");
        return (Map<String, Object>) parsed;
    }

    static Object parse(String json) {
        return new Parser(json).parse();
    }

    static String stringify(Object value) {
        if (value == null) return "null";
        if (value instanceof String) return quote((String) value);
        if (value instanceof Boolean) return ((Boolean) value) ? "true" : "false";
        if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte) {
            return String.valueOf(value);
        }
        if (value instanceof Float || value instanceof Double) {
            double number = ((Number) value).doubleValue();
            if (!Double.isFinite(number)) throw new IllegalArgumentException("json number must be finite");
            return String.valueOf(value);
        }
        if (value instanceof Map) {
            StringBuilder out = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
                if (!(entry.getKey() instanceof String)) throw new IllegalArgumentException("json object keys must be strings");
                if (!first) out.append(',');
                first = false;
                out.append(quote((String) entry.getKey())).append(':').append(stringify(entry.getValue()));
            }
            return out.append('}').toString();
        }
        if (value instanceof List) {
            StringBuilder out = new StringBuilder("[");
            List<?> list = (List<?>) value;
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) out.append(',');
                out.append(stringify(list.get(i)));
            }
            return out.append(']').toString();
        }
        throw new IllegalArgumentException("unsupported json value");
    }

    static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\b': out.append("\\b"); break;
                case '\f': out.append("\\f"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    private static final class Parser {
        private final String input;
        private int pos;

        Parser(String input) {
            this.input = input;
        }

        Object parse() {
            Object value = parseValue();
            skipWhitespace();
            if (pos != input.length()) throw error("unexpected trailing json");
            return value;
        }

        private Object parseValue() {
            skipWhitespace();
            if (pos >= input.length()) throw error("unexpected end of json");
            char c = input.charAt(pos);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't') return parseLiteral("true", Boolean.TRUE);
            if (c == 'f') return parseLiteral("false", Boolean.FALSE);
            if (c == 'n') return parseLiteral("null", null);
            if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
            throw error("unexpected json value");
        }

        private Map<String, Object> parseObject() {
            expect('{');
            Map<String, Object> out = new LinkedHashMap<>();
            skipWhitespace();
            if (peek('}')) {
                pos++;
                return out;
            }
            while (true) {
                skipWhitespace();
                if (pos >= input.length() || input.charAt(pos) != '"') throw error("json object key must be a string");
                String key = parseString();
                skipWhitespace();
                expect(':');
                out.put(key, parseValue());
                skipWhitespace();
                if (peek('}')) {
                    pos++;
                    return out;
                }
                expect(',');
            }
        }

        private List<Object> parseArray() {
            expect('[');
            List<Object> out = new ArrayList<>();
            skipWhitespace();
            if (peek(']')) {
                pos++;
                return out;
            }
            while (true) {
                out.add(parseValue());
                skipWhitespace();
                if (peek(']')) {
                    pos++;
                    return out;
                }
                expect(',');
            }
        }

        private String parseString() {
            expect('"');
            StringBuilder out = new StringBuilder();
            while (pos < input.length()) {
                char c = input.charAt(pos++);
                if (c == '"') return out.toString();
                if (c < 0x20) throw error("json string contains a control character");
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                if (pos >= input.length()) throw error("unterminated json escape");
                char escaped = input.charAt(pos++);
                switch (escaped) {
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        if (pos + 4 > input.length()) throw error("unterminated unicode escape");
                        try {
                            out.append((char) Integer.parseInt(input.substring(pos, pos + 4), 16));
                        } catch (NumberFormatException e) {
                            throw error("invalid unicode escape");
                        }
                        pos += 4;
                        break;
                    default:
                        throw error("invalid json escape");
                }
            }
            throw error("unterminated json string");
        }

        private Object parseLiteral(String literal, Object value) {
            if (!input.startsWith(literal, pos)) throw error("invalid json literal");
            pos += literal.length();
            return value;
        }

        private Number parseNumber() {
            int start = pos;
            if (peek('-')) pos++;
            if (pos >= input.length()) throw error("invalid json number");
            if (peek('0')) {
                pos++;
            } else if (isDigitOneToNine(input.charAt(pos))) {
                while (pos < input.length() && isDigit(input.charAt(pos))) pos++;
            } else {
                throw error("invalid json number");
            }
            boolean decimal = false;
            if (peek('.')) {
                decimal = true;
                pos++;
                if (pos >= input.length() || !isDigit(input.charAt(pos))) throw error("invalid json number");
                while (pos < input.length() && isDigit(input.charAt(pos))) pos++;
            }
            if (peek('e') || peek('E')) {
                decimal = true;
                pos++;
                if (peek('+') || peek('-')) pos++;
                if (pos >= input.length() || !isDigit(input.charAt(pos))) throw error("invalid json number");
                while (pos < input.length() && isDigit(input.charAt(pos))) pos++;
            }
            String raw = input.substring(start, pos);
            try {
                if (decimal) return Double.valueOf(raw);
                return Long.valueOf(raw);
            } catch (NumberFormatException e) {
                throw error("invalid json number");
            }
        }

        private void expect(char expected) {
            if (pos >= input.length() || input.charAt(pos) != expected) throw error("expected '" + expected + "'");
            pos++;
        }

        private boolean peek(char expected) {
            return pos < input.length() && input.charAt(pos) == expected;
        }

        private void skipWhitespace() {
            while (pos < input.length()) {
                char c = input.charAt(pos);
                if (c != ' ' && c != '\n' && c != '\r' && c != '\t') return;
                pos++;
            }
        }

        private IllegalArgumentException error(String message) {
            return new IllegalArgumentException(message + " at " + pos);
        }

        private static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }

        private static boolean isDigitOneToNine(char c) {
            return c >= '1' && c <= '9';
        }
    }
}
