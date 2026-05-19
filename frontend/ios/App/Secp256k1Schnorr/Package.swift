// swift-tools-version: 6.1

import PackageDescription

// This package exists to request the secp256k1.swift `schnorrsig`
// trait from Xcode without editing Capacitor-managed CapApp-SPM.
let package = Package(
    name: "Secp256k1Schnorr",
    products: [
        .library(name: "Secp256k1SchnorrFeature", targets: ["Secp256k1SchnorrFeature"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/GigaBitcoin/secp256k1.swift.git",
            exact: "0.23.1",
            traits: ["schnorrsig"]
        )
    ],
    targets: [
        .target(
            name: "Secp256k1SchnorrFeature",
            dependencies: [
                .product(name: "libsecp256k1", package: "secp256k1.swift")
            ]
        )
    ]
)
