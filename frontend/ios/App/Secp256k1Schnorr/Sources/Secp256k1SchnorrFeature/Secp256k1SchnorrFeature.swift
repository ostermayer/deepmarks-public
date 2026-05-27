import libsecp256k1

// Linking this product forces Xcode's package graph to build
// libsecp256k1 with the schnorrsig trait enabled.
public enum Secp256k1SchnorrFeature {
    public static let isAvailable = true
}
