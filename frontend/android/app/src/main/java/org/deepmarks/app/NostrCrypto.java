package org.deepmarks.app;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class NostrCrypto {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final BigInteger ZERO = BigInteger.ZERO;
    private static final BigInteger ONE = BigInteger.ONE;
    private static final BigInteger TWO = BigInteger.valueOf(2);
    private static final BigInteger THREE = BigInteger.valueOf(3);
    private static final BigInteger SEVEN = BigInteger.valueOf(7);
    private static final BigInteger P = new BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F",
        16
    );
    private static final BigInteger N = new BigInteger(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
        16
    );
    private static final BigInteger SQRT_EXPONENT = P.add(ONE).shiftRight(2);
    private static final Point G = new Point(
        new BigInteger("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16),
        new BigInteger("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", 16)
    );

    private NostrCrypto() {}

    static byte[] randomBytes(int len) {
        byte[] out = new byte[len];
        RANDOM.nextBytes(out);
        return out;
    }

    static String publicKeyHex(String nsecHex) {
        BigInteger d = secret(nsecHex);
        return hex(to32(multiply(d, G).x));
    }

    static byte[] sharedSecretX(String nsecHex, String peerPubkeyHex) {
        BigInteger d = secret(nsecHex);
        Point peer = liftX(peerPubkeyHex);
        Point shared = multiply(d, peer);
        if (shared.infinity) throw new IllegalArgumentException("invalid shared secret");
        return to32(shared.x);
    }

    static String schnorrSignHex(byte[] msg32, String nsecHex) throws Exception {
        if (msg32.length != 32) throw new IllegalArgumentException("message must be 32 bytes");
        BigInteger d0 = secret(nsecHex);
        Point p = multiply(d0, G);
        BigInteger d = hasEvenY(p) ? d0 : N.subtract(d0);
        byte[] pk = to32(p.x);
        byte[] aux = randomBytes(32);
        byte[] auxHash = taggedHash("BIP0340/aux", aux);
        byte[] dBytes = to32(d);
        byte[] t = new byte[32];
        for (int i = 0; i < 32; i++) t[i] = (byte) (dBytes[i] ^ auxHash[i]);
        BigInteger k0 = new BigInteger(1, taggedHash("BIP0340/nonce", concat(t, pk, msg32))).mod(N);
        if (k0.equals(ZERO)) throw new IllegalStateException("schnorr nonce is zero");
        Point r = multiply(k0, G);
        BigInteger k = hasEvenY(r) ? k0 : N.subtract(k0);
        BigInteger e = new BigInteger(1, taggedHash("BIP0340/challenge", concat(to32(r.x), pk, msg32))).mod(N);
        BigInteger s = k.add(e.multiply(d)).mod(N);
        return hex(concat(to32(r.x), to32(s)));
    }

    static boolean schnorrVerify(byte[] msg32, String pubkeyHex, String sigHex) throws Exception {
        try {
            if (msg32.length != 32 || !sigHex.matches("^[0-9a-fA-F]{128}$")) return false;
            Point publicKey = liftX(pubkeyHex);
            byte[] sig = bytesFromHex(sigHex);
            BigInteger r = new BigInteger(1, java.util.Arrays.copyOfRange(sig, 0, 32));
            BigInteger s = new BigInteger(1, java.util.Arrays.copyOfRange(sig, 32, 64));
            if (r.compareTo(P) >= 0 || s.compareTo(N) >= 0) return false;
            byte[] challenge = concat(to32(r), bytesFromHex(pubkeyHex), msg32);
            BigInteger e = new BigInteger(1, taggedHash("BIP0340/challenge", challenge)).mod(N);
            Point rPoint = add(multiply(s, G), multiply(N.subtract(e).mod(N), publicKey));
            return !rPoint.infinity && hasEvenY(rPoint) && rPoint.x.equals(r);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    static byte[] sha256(byte[] bytes) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(bytes);
    }

    static byte[] hmacSha256(byte[] key, byte[] data) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    static byte[] hkdfExtract(byte[] salt, byte[] ikm) throws Exception {
        return hmacSha256(salt, ikm);
    }

    static byte[] hkdfExpand(byte[] prk, byte[] info, int len) throws Exception {
        if (len < 0 || len > 255 * 32) throw new IllegalArgumentException("invalid hkdf length");
        byte[] out = new byte[len];
        byte[] previous = new byte[0];
        int copied = 0;
        int counter = 1;
        while (copied < len) {
            byte[] input = concat(previous, info, new byte[] { (byte) counter });
            previous = hmacSha256(prk, input);
            int take = Math.min(previous.length, len - copied);
            System.arraycopy(previous, 0, out, copied, take);
            copied += take;
            counter += 1;
        }
        return out;
    }

    static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a.length != b.length) return false;
        int diff = 0;
        for (int i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff == 0;
    }

    static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }

    static byte[] bytesFromHex(String hex) {
        if ((hex.length() & 1) != 0) throw new IllegalArgumentException("hex length must be even");
        int len = hex.length();
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            out[i / 2] = (byte) Integer.parseInt(hex.substring(i, i + 2), 16);
        }
        return out;
    }

    static byte[] concat(byte[]... arrays) {
        int len = 0;
        for (byte[] arr : arrays) len += arr.length;
        byte[] out = new byte[len];
        int pos = 0;
        for (byte[] arr : arrays) {
            System.arraycopy(arr, 0, out, pos, arr.length);
            pos += arr.length;
        }
        return out;
    }

    private static BigInteger secret(String nsecHex) {
        BigInteger d = new BigInteger(1, bytesFromHex(nsecHex));
        if (d.signum() <= 0 || d.compareTo(N) >= 0) throw new IllegalArgumentException("invalid nsec");
        return d;
    }

    private static byte[] taggedHash(String tag, byte[] msg) throws Exception {
        byte[] tagHash = sha256(tag.getBytes(StandardCharsets.UTF_8));
        return sha256(concat(tagHash, tagHash, msg));
    }

    private static Point liftX(String xHex) {
        if (!xHex.matches("^[0-9a-fA-F]{64}$")) throw new IllegalArgumentException("invalid pubkey");
        BigInteger x = new BigInteger(1, bytesFromHex(xHex));
        if (x.compareTo(P) >= 0) throw new IllegalArgumentException("invalid pubkey");
        BigInteger y2 = x.modPow(THREE, P).add(SEVEN).mod(P);
        BigInteger y = y2.modPow(SQRT_EXPONENT, P);
        if (!y.multiply(y).mod(P).equals(y2)) throw new IllegalArgumentException("invalid pubkey");
        if (!hasEvenY(new Point(x, y))) y = P.subtract(y);
        return new Point(x, y);
    }

    private static boolean hasEvenY(Point p) {
        return p.y.mod(TWO).equals(ZERO);
    }

    private static Point multiply(BigInteger scalar, Point point) {
        Point result = Point.infinity();
        for (int i = scalar.bitLength() - 1; i >= 0; i--) {
            result = doublePoint(result);
            if (scalar.testBit(i)) result = add(result, point);
        }
        return result;
    }

    private static Point add(Point a, Point b) {
        if (a.infinity) return b;
        if (b.infinity) return a;
        if (a.x.equals(b.x)) {
            if (a.y.add(b.y).mod(P).equals(ZERO)) return Point.infinity();
            return doublePoint(a);
        }
        BigInteger lambda = b.y.subtract(a.y)
            .multiply(b.x.subtract(a.x).mod(P).modInverse(P))
            .mod(P);
        BigInteger x = lambda.multiply(lambda).subtract(a.x).subtract(b.x).mod(P);
        BigInteger y = lambda.multiply(a.x.subtract(x)).subtract(a.y).mod(P);
        return new Point(x, y);
    }

    private static Point doublePoint(Point a) {
        if (a.infinity || a.y.equals(ZERO)) return Point.infinity();
        BigInteger lambda = THREE.multiply(a.x).multiply(a.x)
            .multiply(TWO.multiply(a.y).mod(P).modInverse(P))
            .mod(P);
        BigInteger x = lambda.multiply(lambda).subtract(TWO.multiply(a.x)).mod(P);
        BigInteger y = lambda.multiply(a.x.subtract(x)).subtract(a.y).mod(P);
        return new Point(x, y);
    }

    private static byte[] to32(BigInteger value) {
        byte[] raw = value.toByteArray();
        byte[] out = new byte[32];
        int src = raw.length > 32 ? raw.length - 32 : 0;
        int len = Math.min(raw.length, 32);
        System.arraycopy(raw, src, out, 32 - len, len);
        return out;
    }

    private static final class Point {
        final BigInteger x;
        final BigInteger y;
        final boolean infinity;

        Point(BigInteger x, BigInteger y) {
            this.x = x;
            this.y = y;
            this.infinity = false;
        }

        private Point() {
            this.x = ZERO;
            this.y = ZERO;
            this.infinity = true;
        }

        static Point infinity() {
            return new Point();
        }
    }
}
