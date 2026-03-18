// swift-tools-version: 6.0

import PackageDescription

let ghosttyXCFramework = "vendor/ghostty/macos/GhosttyKit.xcframework/macos-arm64_x86_64"

let package = Package(
    name: "Manor",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .target(
            name: "CGhosttyKit",
            path: "Sources/CGhosttyKit",
            publicHeadersPath: "include"
        ),
        .target(
            name: "ManorCore",
            path: "Sources/ManorCore",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        .executableTarget(
            name: "ManorApp",
            dependencies: ["CGhosttyKit", "ManorCore"],
            path: "Sources/ManorApp",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreText"),
                .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("IOKit"),
                .linkedFramework("Carbon"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("IOSurface"),
                .unsafeFlags(["-L", "\(ghosttyXCFramework)", "-lghostty", "-lc++"]),
            ]
        ),
        .testTarget(
            name: "ManorTests",
            dependencies: ["ManorCore"],
            path: "Tests/ManorTests",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
