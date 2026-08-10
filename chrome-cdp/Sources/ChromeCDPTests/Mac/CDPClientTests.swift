import ChromeCDPCore
import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private final class CDPStubStore: @unchecked Sendable {
    struct Stub {
        let status: Int
        let data: Data
    }

    static let shared = CDPStubStore()

    private let lock = NSLock()
    private var stubs: [String: Stub] = [:]
    private var requests: [URLRequest] = []

    func reset(_ responses: [String: Stub]) {
        lock.lock()
        stubs = responses
        requests = []
        lock.unlock()
    }

    func response(for request: URLRequest) -> Stub? {
        lock.lock()
        requests.append(request)
        let response = request.url.flatMap { stubs[$0.relativeString] }
        lock.unlock()
        return response
    }

    func recordedRequests() -> [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }
}

private final class CDPStubURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let stub = CDPStubStore.shared.response(for: request), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: stub.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private let cdpConfiguration = LauncherConfiguration.production(
    homeDirectory: URL(fileURLWithPath: "/tmp/chrome-cdp-test-home", isDirectory: true)
)

private func cdpSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CDPStubURLProtocol.self]
    return URLSession(configuration: configuration)
}

private func cdpResponses(version: String, targets: String) -> [String: CDPStubStore.Stub] {
    [
        "http://127.0.0.1:9222/json/version": .init(status: 200, data: Data(version.utf8)),
        "http://127.0.0.1:9222/json/list": .init(status: 200, data: Data(targets.utf8))
    ]
}

func cdpClientAcceptsChromeVersionAndCountsOnlyPageTargetsTest() throws {
    CDPStubStore.shared.reset(cdpResponses(
        version: #"{"Browser":"Chrome/126.0.0.0","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#,
        targets: #"[{"id":"page-1","type":"page"},{"id":"worker-1","type":"service_worker"},{"id":"page-2","type":"page"}]"#
    ))

    let observation = try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) }

    try expectEqual(
        observation,
        .healthy(webSocketURL: URL(string: "ws://127.0.0.1:9222/devtools/browser/id")!, pageTargetCount: 2)
    )
}

func cdpClientRejectsMissingVersionFieldsTest() throws {
    CDPStubStore.shared.reset(cdpResponses(version: #"{"Browser":"Chrome/126"}"#, targets: "[]"))

    let observation = try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) }

    try expectEqual(observation, .invalid(.malformedVersion))
}

func cdpClientRejectsMalformedVersionJSONTest() throws {
    CDPStubStore.shared.reset(cdpResponses(version: "{not json", targets: "[]"))

    let observation = try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) }

    try expectEqual(observation, .invalid(.malformedVersion))
}

func cdpClientRejectsNonChromeBrowserTest() throws {
    CDPStubStore.shared.reset(cdpResponses(
        version: #"{"Browser":"Chromium/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#,
        targets: "[]"
    ))

    try expectEqual(
        try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .invalid(.nonChromeBrowser)
    )
}

func cdpClientRejectsUnsafeWebSocketURLsTest() throws {
    let invalidURLs: [(String, EndpointFailure)] = [
        ("http://127.0.0.1:9222/devtools/browser/id", .invalidWebSocket),
        ("ws://public.example:9222/devtools/browser/id", .nonLoopbackWebSocket),
        ("ws://0.0.0.0:9222/devtools/browser/id", .nonLoopbackWebSocket),
        ("ws://127.0.0.1:9223/devtools/browser/id", .wrongWebSocketPort)
    ]

    for (url, expected) in invalidURLs {
        CDPStubStore.shared.reset(cdpResponses(
            version: "{\"Browser\":\"Chrome/126\",\"webSocketDebuggerUrl\":\"\(url)\"}",
            targets: "[]"
        ))
        try expectEqual(
            try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
            .invalid(expected),
            "must reject \(url)"
        )
    }
}

func cdpClientAcceptsDocumentedLoopbackWebSocketHostsTest() throws {
    for host in ["127.0.0.1", "localhost", "[::1]"] {
        CDPStubStore.shared.reset(cdpResponses(
            version: "{\"Browser\":\"Chrome/126\",\"webSocketDebuggerUrl\":\"ws://\(host):9222/devtools/browser/id\"}",
            targets: "[]"
        ))
        let expectedURL = URL(string: "ws://\(host):9222/devtools/browser/id")!
        try expectEqual(
            try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
            .healthy(webSocketURL: expectedURL, pageTargetCount: 0)
        )
    }
}

func cdpClientRejectsMalformedTargetListTest() throws {
    CDPStubStore.shared.reset(cdpResponses(
        version: #"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#,
        targets: #"[{"id":"page-1"}]"#
    ))

    try expectEqual(
        try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .invalid(.malformedTargetList)
    )
}

func cdpClientReportsZeroPagesWhenOnlyNonPageTargetsExistTest() throws {
    CDPStubStore.shared.reset(cdpResponses(
        version: #"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#,
        targets: #"[{"id":"worker","type":"service_worker"}]"#
    ))

    try expectEqual(
        try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .healthy(webSocketURL: URL(string: "ws://127.0.0.1:9222/devtools/browser/id")!, pageTargetCount: 0)
    )
}

func cdpClientCreatesBlankTargetWithFixedPutEndpointTest() throws {
    CDPStubStore.shared.reset([
        "http://127.0.0.1:9222/json/new?about:blank": .init(
            status: 200,
            data: Data(#"{"id":"page-1","type":"page"}"#.utf8)
        )
    ])

    try awaitValue { try await CDPClient(session: cdpSession()).createBlankTarget(configuration: cdpConfiguration) }

    let requests = CDPStubStore.shared.recordedRequests()
    try expectEqual(requests.count, 1)
    try expectEqual(requests[0].url?.relativeString, "http://127.0.0.1:9222/json/new?about:blank")
    try expectEqual(requests[0].httpMethod, "PUT")
}

func cdpClientRejectsNonPageBlankTargetResponseTest() throws {
    CDPStubStore.shared.reset([
        "http://127.0.0.1:9222/json/new?about:blank": .init(status: 200, data: Data(#"{"id":"worker","type":"service_worker"}"#.utf8))
    ])

    do {
        try awaitValue { try await CDPClient(session: cdpSession()).createBlankTarget(configuration: cdpConfiguration) }
    } catch CDPClientError.malformedCreateResponse {
        return
    } catch {
        throw TestAssertionFailure("expected malformed create response, got \(error)")
    }
    throw TestAssertionFailure("expected malformed create response")
}

func cdpClientTests() throws {
    try cdpClientAcceptsChromeVersionAndCountsOnlyPageTargetsTest()
    try cdpClientRejectsMissingVersionFieldsTest()
    try cdpClientRejectsMalformedVersionJSONTest()
    try cdpClientRejectsNonChromeBrowserTest()
    try cdpClientRejectsUnsafeWebSocketURLsTest()
    try cdpClientAcceptsDocumentedLoopbackWebSocketHostsTest()
    try cdpClientRejectsMalformedTargetListTest()
    try cdpClientReportsZeroPagesWhenOnlyNonPageTargetsExistTest()
    try cdpClientCreatesBlankTargetWithFixedPutEndpointTest()
    try cdpClientRejectsNonPageBlankTargetResponseTest()
}

func registerCDPClientTests(_ runner: inout TestRunner) {
    runner.register("CDPClientTests", cdpClientTests)
    runner.register("CDPClientTests.AcceptsChromeVersionAndCountsOnlyPageTargets", cdpClientAcceptsChromeVersionAndCountsOnlyPageTargetsTest)
    runner.register("CDPClientTests.RejectsMissingVersionFields", cdpClientRejectsMissingVersionFieldsTest)
    runner.register("CDPClientTests.RejectsMalformedVersionJSON", cdpClientRejectsMalformedVersionJSONTest)
    runner.register("CDPClientTests.RejectsNonChromeBrowser", cdpClientRejectsNonChromeBrowserTest)
    runner.register("CDPClientTests.RejectsUnsafeWebSocketURLs", cdpClientRejectsUnsafeWebSocketURLsTest)
    runner.register("CDPClientTests.AcceptsDocumentedLoopbackWebSocketHosts", cdpClientAcceptsDocumentedLoopbackWebSocketHostsTest)
    runner.register("CDPClientTests.RejectsMalformedTargetList", cdpClientRejectsMalformedTargetListTest)
    runner.register("CDPClientTests.ReportsZeroPagesWhenOnlyNonPageTargetsExist", cdpClientReportsZeroPagesWhenOnlyNonPageTargetsExistTest)
    runner.register("CDPClientTests.CreatesBlankTargetWithFixedPutEndpoint", cdpClientCreatesBlankTargetWithFixedPutEndpointTest)
    runner.register("CDPClientTests.RejectsNonPageBlankTargetResponse", cdpClientRejectsNonPageBlankTargetResponseTest)
}
