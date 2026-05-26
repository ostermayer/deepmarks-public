package org.deepmarks.app;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class NostrBech32 {
    private static final String CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    private static final int[] GENERATOR = {
        0x3b6a57b2,
        0x26508e6d,
        0x1ea119fa,
        0x3d4233dd,
        0x2a1462b3
    };

    private NostrBech32() {}

    static String encode(String hrp, byte[] bytes) {
        int[] data = convertBits(bytes, 8, 5, true);
        int[] checksum = createChecksum(hrp, data);
        StringBuilder out = new StringBuilder(hrp.length() + 1 + data.length + checksum.length);
        out.append(hrp).append('1');
        for (int value : data) out.append(CHARSET.charAt(value));
        for (int value : checksum) out.append(CHARSET.charAt(value));
        return out.toString();
    }

    static byte[] decode(String value, String expectedHrp) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("empty bech32 value");
        String normalized = value.toLowerCase(Locale.ROOT);
        if (!value.equals(normalized) && !value.equals(value.toUpperCase(Locale.ROOT))) {
            throw new IllegalArgumentException("mixed-case bech32 value");
        }
        int separator = normalized.lastIndexOf('1');
        if (separator < 1 || separator + 7 > normalized.length()) {
            throw new IllegalArgumentException("invalid bech32 value");
        }
        String hrp = normalized.substring(0, separator);
        if (!expectedHrp.equals(hrp)) throw new IllegalArgumentException("unexpected bech32 prefix");
        int[] values = new int[normalized.length() - separator - 1];
        for (int i = 0; i < values.length; i++) {
            int idx = CHARSET.indexOf(normalized.charAt(separator + 1 + i));
            if (idx < 0) throw new IllegalArgumentException("invalid bech32 character");
            values[i] = idx;
        }
        if (!verifyChecksum(hrp, values)) throw new IllegalArgumentException("invalid bech32 checksum");
        int[] data = new int[values.length - 6];
        System.arraycopy(values, 0, data, 0, data.length);
        int[] decoded = convertBits(data, 5, 8, false);
        byte[] out = new byte[decoded.length];
        for (int i = 0; i < decoded.length; i++) out[i] = (byte) decoded[i];
        return out;
    }

    private static int[] createChecksum(String hrp, int[] data) {
        int[] values = concat(hrpExpand(hrp), data, new int[] { 0, 0, 0, 0, 0, 0 });
        int polymod = polymod(values) ^ 1;
        int[] out = new int[6];
        for (int i = 0; i < 6; i++) out[i] = (polymod >> (5 * (5 - i))) & 31;
        return out;
    }

    private static boolean verifyChecksum(String hrp, int[] data) {
        return polymod(concat(hrpExpand(hrp), data)) == 1;
    }

    private static int polymod(int[] values) {
        int chk = 1;
        for (int value : values) {
            int top = chk >>> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ value;
            for (int i = 0; i < 5; i++) {
                if (((top >>> i) & 1) == 1) chk ^= GENERATOR[i];
            }
        }
        return chk;
    }

    private static int[] hrpExpand(String hrp) {
        int[] out = new int[hrp.length() * 2 + 1];
        for (int i = 0; i < hrp.length(); i++) out[i] = hrp.charAt(i) >>> 5;
        out[hrp.length()] = 0;
        for (int i = 0; i < hrp.length(); i++) out[hrp.length() + 1 + i] = hrp.charAt(i) & 31;
        return out;
    }

    private static int[] convertBits(int[] data, int fromBits, int toBits, boolean pad) {
        int acc = 0;
        int bits = 0;
        int maxv = (1 << toBits) - 1;
        int maxAcc = (1 << (fromBits + toBits - 1)) - 1;
        List<Integer> out = new ArrayList<>();
        for (int value : data) {
            if (value < 0 || (value >>> fromBits) != 0) throw new IllegalArgumentException("invalid bech32 data");
            acc = ((acc << fromBits) | value) & maxAcc;
            bits += fromBits;
            while (bits >= toBits) {
                bits -= toBits;
                out.add((acc >>> bits) & maxv);
            }
        }
        if (pad) {
            if (bits > 0) out.add((acc << (toBits - bits)) & maxv);
        } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) != 0) {
            throw new IllegalArgumentException("invalid bech32 padding");
        }
        int[] result = new int[out.size()];
        for (int i = 0; i < out.size(); i++) result[i] = out.get(i);
        return result;
    }

    private static int[] convertBits(byte[] data, int fromBits, int toBits, boolean pad) {
        int[] ints = new int[data.length];
        for (int i = 0; i < data.length; i++) ints[i] = data[i] & 0xff;
        return convertBits(ints, fromBits, toBits, pad);
    }

    private static int[] concat(int[]... arrays) {
        int len = 0;
        for (int[] arr : arrays) len += arr.length;
        int[] out = new int[len];
        int pos = 0;
        for (int[] arr : arrays) {
            System.arraycopy(arr, 0, out, pos, arr.length);
            pos += arr.length;
        }
        return out;
    }
}
