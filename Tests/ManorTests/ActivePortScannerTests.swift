import XCTest
@testable import ManorCore

final class ActivePortScannerTests: XCTestCase {

    // MARK: - parse

    func testParseEmptyOutputReturnsEmpty() {
        let result = ActivePortScanner.parse("")
        XCTAssertTrue(result.isEmpty)
    }

    func testParseSinglePort() {
        // lsof -F pcn output: p=pid, c=command, n=network address
        let output = """
        p1234
        cnode
        n*:3000
        """

        let result = ActivePortScanner.parse(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].port, 3000)
        XCTAssertEqual(result[0].processName, "node")
        XCTAssertEqual(result[0].pid, 1234)
    }

    func testParseMultiplePorts() {
        let output = """
        p100
        cnode
        n*:3000
        p200
        cpython
        n127.0.0.1:8000
        p300
        cruby
        n*:4567
        """

        let result = ActivePortScanner.parse(output)

        XCTAssertEqual(result.count, 3)
        // Results are sorted by port
        XCTAssertEqual(result[0].port, 3000)
        XCTAssertEqual(result[1].port, 4567)
        XCTAssertEqual(result[2].port, 8000)
    }

    func testParseSortsPortsAscending() {
        let output = """
        p1
        cfoo
        n*:9000
        p2
        cbar
        n*:1000
        p3
        cbaz
        n*:5000
        """

        let result = ActivePortScanner.parse(output)

        XCTAssertEqual(result.map(\.port), [1000, 5000, 9000])
    }

    func testParseDeduplicatesDuplicatePorts() {
        // Same port appearing twice (e.g., listening on both IPv4 and IPv6)
        let output = """
        p100
        cnode
        n*:3000
        p100
        cnode
        n:::3000
        """

        let result = ActivePortScanner.parse(output)

        // Should only appear once
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].port, 3000)
    }

    func testParseIPv6Address() {
        let output = """
        p500
        cgo
        n[::1]:8080
        """

        let result = ActivePortScanner.parse(output)

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].port, 8080)
        XCTAssertEqual(result[0].processName, "go")
    }

    func testParseIgnoresLinesWithoutPrefix() {
        // Lines that are empty or don't have a recognized prefix are skipped
        let output = """
        p999
        capp
        n*:4000

        """

        let result = ActivePortScanner.parse(output)
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].port, 4000)
    }

    func testParseGarbageNetworkAddressSkipped() {
        let output = """
        p111
        capp
        nnoport
        """

        let result = ActivePortScanner.parse(output)
        XCTAssertTrue(result.isEmpty, "Address without a valid port should be skipped")
    }

    func testParseProcessNameUpdatesWithEachPIDBlock() {
        let output = """
        p1
        cfirst
        n*:1111
        p2
        csecond
        n*:2222
        """

        let result = ActivePortScanner.parse(output)

        XCTAssertEqual(result.count, 2)
        let port1111 = result.first { $0.port == 1111 }
        let port2222 = result.first { $0.port == 2222 }
        XCTAssertEqual(port1111?.processName, "first")
        XCTAssertEqual(port2222?.processName, "second")
    }
}
