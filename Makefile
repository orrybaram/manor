SDK = /Library/Developer/CommandLineTools/SDKs/MacOSX26.2.sdk
TARGET = arm64-apple-macosx15.0
VFS_OVERLAY = vfs_fix.yaml
BUILD_DIR = .build
BINARY = $(BUILD_DIR)/manor

# GhosttyKit paths
GHOSTTY_DIR = vendor/ghostty
GHOSTTY_XCFRAMEWORK_DIR = $(GHOSTTY_DIR)/macos/GhosttyKit.xcframework/macos-arm64_x86_64
GHOSTTY_INCLUDE = $(GHOSTTY_XCFRAMEWORK_DIR)/Headers
GHOSTTY_LIB = $(GHOSTTY_XCFRAMEWORK_DIR)
BRIDGING_HEADER = Sources/ManorApp/BridgingHeader.h

SWIFTC = swiftc
SWIFT_FLAGS = \
	-sdk $(SDK) \
	-target $(TARGET) \
	-vfsoverlay $(VFS_OVERLAY) \
	-O \
	-module-name ManorApp \
	-parse-as-library \
	-import-objc-header $(BRIDGING_HEADER) \
	-I $(GHOSTTY_INCLUDE)

# Frameworks needed
FRAMEWORKS = -framework AppKit -framework CoreText -framework Foundation \
	-framework Metal -framework QuartzCore -framework IOKit \
	-framework Carbon -framework CoreGraphics -framework IOSurface

# GhosttyKit linker flags (includes C++ stdlib for GLSL/SPIR-V cross-compilation)
LDFLAGS = -L$(GHOSTTY_LIB) -lghostty -lc++

SOURCES = $(shell find Sources/ManorApp -name '*.swift' | sort)

.PHONY: all clean run debug ghostty sync-ghostty-header

all: $(BINARY)

$(BINARY): $(SOURCES) $(VFS_OVERLAY) | $(BUILD_DIR)
	$(SWIFTC) $(SWIFT_FLAGS) $(FRAMEWORKS) $(LDFLAGS) $(SOURCES) -o $(BINARY)

debug: clean
debug: SWIFT_FLAGS = -sdk $(SDK) -target $(TARGET) -vfsoverlay $(VFS_OVERLAY) -g -Onone -module-name ManorApp -parse-as-library -import-objc-header $(BRIDGING_HEADER) -I $(GHOSTTY_INCLUDE)
debug: $(BINARY)

# Build GhosttyKit from source (requires zig)
ghostty:
	cd $(GHOSTTY_DIR) && zig build -Dapp-runtime=none -Demit-xcframework=true \
		-Doptimize=ReleaseFast

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

run: $(BINARY)
	./$(BINARY)

# Copy ghostty.h into CGhosttyKit/include so SPM doesn't discover the
# xcframework's GhosttyKit modulemap. Run after updating the ghostty submodule.
sync-ghostty-header:
	cp $(GHOSTTY_INCLUDE)/ghostty.h Sources/CGhosttyKit/include/ghostty.h

clean:
	rm -rf $(BUILD_DIR)
