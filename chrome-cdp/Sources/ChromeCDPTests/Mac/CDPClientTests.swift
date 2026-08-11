import ChromeCDPCore
import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private final class CDPStubStore: @unchecked Sendable {
    struct Stub {
        let status: Int
        let data: Data
        let responseURL: URL?
        let headers: [String: String]
        let delay: TimeInterval
        let error: URLError.Code?
        let hangs: Bool

        init(
            status: Int,
            data: Data,
            responseURL: URL? = nil,
            headers: [String: String] = [:],
            delay: TimeInterval = 0
        ) {
            self.status = status
            self.data = data
            self.responseURL = responseURL
            self.headers = headers
            self.delay = delay
            error = nil
            hangs = false
        }

        static func failure(_ code: URLError.Code) -> Stub {
            Stub(status: 0, data: Data(), responseURL: nil, headers: [:], delay: 0, error: code, hangs: false)
        }

        static let hanging = Stub(status: 0, data: Data(), responseURL: nil, headers: [:], delay: 0, error: nil, hangs: true)

        private init(
            status: Int,
            data: Data,
            responseURL: URL?,
            headers: [String: String],
            delay: TimeInterval,
            error: URLError.Code?,
            hangs: Bool
        ) {
            self.status = status
            self.data = data
            self.responseURL = responseURL
            self.headers = headers
            self.delay = delay
            self.error = error
            self.hangs = hangs
        }
    }

    static let shared = CDPStubStore()

    private let lock = NSLock()
    private var stubs: [String: Stub] = [:]
    private var requests: [URLRequest] = []
    private var deliveries: [String] = []

    func reset(_ responses: [String: Stub]) {
        lock.lock()
        stubs = responses
        requests = []
        deliveries = []
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

    func recordDelivery(for request: URLRequest) {
        lock.lock()
        if let url = request.url?.relativeString {
            deliveries.append(url)
        }
        lock.unlock()
    }

    func recordedDeliveries() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return deliveries
    }
}

private final class CDPStubURLProtocol: URLProtocol, @unchecked Sendable {
    private let lifecycleLock = NSLock()
    private var stopped = false
    private var completed = false
    private var delayedWorkItem: DispatchWorkItem?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let stub = CDPStubStore.shared.response(for: request), let url = request.url else {
            guard claimDelivery() else { return }
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        if let error = stub.error {
            guard claimDelivery() else { return }
            client?.urlProtocol(self, didFailWithError: URLError(error))
            return
        }
        if stub.hangs {
            return
        }
        if stub.delay > 0 {
            let workItem = DispatchWorkItem { [weak self] in
                self?.deliver(stub: stub, url: url)
            }
            lifecycleLock.lock()
            guard !stopped, !completed else {
                lifecycleLock.unlock()
                return
            }
            delayedWorkItem = workItem
            lifecycleLock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + stub.delay, execute: workItem)
        } else {
            deliver(stub: stub, url: url)
        }
    }

    override func stopLoading() {
        lifecycleLock.lock()
        stopped = true
        let workItem = delayedWorkItem
        delayedWorkItem = nil
        lifecycleLock.unlock()
        workItem?.cancel()
    }

    private func claimDelivery() -> Bool {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        guard !stopped, !completed else { return false }
        completed = true
        delayedWorkItem = nil
        return true
    }

    private func deliver(stub: CDPStubStore.Stub, url: URL) {
        guard claimDelivery() else { return }
        CDPStubStore.shared.recordDelivery(for: request)
        var headers = stub.headers
        headers["Content-Type"] = "application/json"
        let response = HTTPURLResponse(
            url: stub.responseURL ?? url,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.data)
        client?.urlProtocolDidFinishLoading(self)
    }
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

private final class CancellationState: @unchecked Sendable {
    private let cancellationSemaphore = DispatchSemaphore(value: 0)
    private let completionSemaphore = DispatchSemaphore(value: 0)

    func markCancelled() {
        cancellationSemaphore.signal()
    }

    func waitForCancellation() -> Bool {
        cancellationSemaphore.wait(timeout: .now() + 0.2) == .success
    }

    func markCompleted() {
        completionSemaphore.signal()
    }

    func waitForCompletion() -> Bool {
        completionSemaphore.wait(timeout: .now() + 0.2) == .success
    }
}

func testSupportTimesOutAndCancelsHangingOperationsTest() throws {
    let state = CancellationState()
    let started = Date()
    do {
        _ = try awaitValue(timeout: 0.01) {
            try await withTaskCancellationHandler(operation: {
                defer { state.markCompleted() }
                try await Task.sleep(for: .seconds(60))
                return 1
            }, onCancel: {
                state.markCancelled()
            })
        }
    } catch let error as TestAssertionFailure {
        try expectEqual(error.description, "async operation timed out after 0.01 seconds")
        try expectEqual(state.waitForCancellation(), true)
        try expectEqual(state.waitForCompletion(), true)
        try expectEqual(Date().timeIntervalSince(started) < 0.5, true)
        return
    }
    throw TestAssertionFailure("expected hanging operation to time out")
}

func testSupportContainsNonCooperativeTimeoutInChildProcessTest() throws {
    let root = try makeTemporaryDirectory(prefix: "chrome-cdp-await-value-")
    defer { try? FileManager.default.removeItem(at: root) }
    let laterTestMarker = root.appendingPathComponent("later-test-ran")
    let child = Process()
    child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
    child.arguments = ["--await-value-noncooperative-child", laterTestMarker.path]
    let output = Pipe()
    let error = Pipe()
    child.standardOutput = output
    child.standardError = error
    try child.run()

    let deadline = Date().addingTimeInterval(1)
    while child.isRunning, Date() < deadline {
        usleep(5_000)
    }
    guard !child.isRunning else {
        child.terminate()
        throw TestAssertionFailure("noncooperative awaitValue child did not exit")
    }
    try expectEqual(child.terminationStatus, 1)
    try expectEqual(FileManager.default.fileExists(atPath: laterTestMarker.path), false)
    _ = output.fileHandleForReading.readDataToEndOfFile()
    _ = error.fileHandleForReading.readDataToEndOfFile()
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

func cdpClientUsesOnlyFixedSecureVersionAndListRequestsTest() throws {
    CDPStubStore.shared.reset(cdpResponses(
        version: #"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#,
        targets: "[]"
    ))

    _ = try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) }

    let requests = CDPStubStore.shared.recordedRequests()
    try expectEqual(requests.map { $0.url?.relativeString }, [
        "http://127.0.0.1:9222/json/version",
        "http://127.0.0.1:9222/json/list"
    ])
    try expectEqual(requests.map(\.httpMethod), ["GET", "GET"])
    for request in requests {
        try expectEqual(request.timeoutInterval > 0 && request.timeoutInterval < 0.2, true)
        try expectEqual(request.cachePolicy, .reloadIgnoringLocalCacheData)
        try expectEqual(request.httpShouldHandleCookies, false)
    }
}

func cdpClientMapsVersionAndListHTTPFailuresToUnavailableTest() throws {
    let version = #"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#
    for failedURL in ["http://127.0.0.1:9222/json/version", "http://127.0.0.1:9222/json/list"] {
        var responses = cdpResponses(version: version, targets: "[]")
        responses[failedURL] = .init(status: 503, data: Data())
        CDPStubStore.shared.reset(responses)

        try expectEqual(
            try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
            .unavailable
        )
    }
}

func cdpClientRejectsRedirectWithoutFollowingTargetTest() throws {
    CDPStubStore.shared.reset([
        "http://127.0.0.1:9222/json/version": .init(
            status: 302,
            data: Data(),
            headers: ["Location": "http://127.0.0.1:9222/not-cdp"]
        )
    ])

    try expectEqual(
        try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .unavailable
    )
    try expectEqual(
        CDPStubStore.shared.recordedRequests().map { $0.url?.relativeString },
        ["http://127.0.0.1:9222/json/version"]
    )
}

func cdpClientRejectsAlternateResponseURLTest() throws {
    CDPStubStore.shared.reset([
        "http://127.0.0.1:9222/json/version": .init(
            status: 200,
            data: Data(#"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#.utf8),
            responseURL: URL(string: "http://127.0.0.1:9222/not-version")
        )
    ])

    try expectEqual(
        try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .unavailable
    )
}

func cdpClientMapsTransportAndDelayedResponsesToUnavailableTest() throws {
    for stub in [CDPStubStore.Stub.failure(.cannotConnectToHost), .init(status: 200, data: Data(), delay: 0.2), .hanging] {
        CDPStubStore.shared.reset(["http://127.0.0.1:9222/json/version": stub])
        try expectEqual(
            try awaitValue(timeout: 0.5) { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
            .unavailable
        )
    }
}

func cdpStubCancelsDelayedCallbacksBeforeLaterTestStateTest() throws {
    let versionURL = "http://127.0.0.1:9222/json/version"
    CDPStubStore.shared.reset([
        versionURL: .init(
            status: 200,
            data: Data(#"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#.utf8),
            delay: 0.2
        )
    ])
    try expectEqual(
        try awaitValue(timeout: 0.5) { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .unavailable
    )

    CDPStubStore.shared.reset(cdpResponses(
        version: #"{"Browser":"Chrome/126","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/id"}"#,
        targets: "[]"
    ))
    try expectEqual(
        try awaitValue { await CDPClient(session: cdpSession()).inspect(configuration: cdpConfiguration) },
        .healthy(webSocketURL: URL(string: "ws://127.0.0.1:9222/devtools/browser/id")!, pageTargetCount: 0)
    )
    usleep(300_000)
    try expectEqual(
        CDPStubStore.shared.recordedDeliveries(),
        [
            "http://127.0.0.1:9222/json/version",
            "http://127.0.0.1:9222/json/list"
        ]
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
    try expectEqual(requests[0].timeoutInterval > 0 && requests[0].timeoutInterval < 0.2, true)
    try expectEqual(requests[0].cachePolicy, .reloadIgnoringLocalCacheData)
    try expectEqual(requests[0].httpShouldHandleCookies, false)
}

func cdpClientMapsCreateHTTPTransportAndRedirectFailuresTest() throws {
    let endpoint = "http://127.0.0.1:9222/json/new?about:blank"
    let stubs: [CDPStubStore.Stub] = [
        .init(status: 500, data: Data()),
        .failure(.cannotConnectToHost),
        .init(status: 302, data: Data(), headers: ["Location": "http://127.0.0.1:9222/not-cdp"]),
        .init(status: 200, data: Data(#"{"type":"page"}"#.utf8), responseURL: URL(string: "http://127.0.0.1:9222/not-new")),
        .hanging
    ]
    for stub in stubs {
        CDPStubStore.shared.reset([endpoint: stub])
        do {
            try awaitValue(timeout: 0.5) { try await CDPClient(session: cdpSession()).createBlankTarget(configuration: cdpConfiguration) }
        } catch CDPClientError.requestFailed {
            continue
        } catch {
            throw TestAssertionFailure("expected rejected create transport boundary, got \(error)")
        }
        throw TestAssertionFailure("expected rejected create transport boundary")
    }
}

func cdpClientRejectsMalformedCreateJSONTest() throws {
    CDPStubStore.shared.reset([
        "http://127.0.0.1:9222/json/new?about:blank": .init(status: 200, data: Data("not json".utf8))
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
    try testSupportTimesOutAndCancelsHangingOperationsTest()
    try testSupportContainsNonCooperativeTimeoutInChildProcessTest()
    try cdpClientAcceptsChromeVersionAndCountsOnlyPageTargetsTest()
    try cdpClientUsesOnlyFixedSecureVersionAndListRequestsTest()
    try cdpClientMapsVersionAndListHTTPFailuresToUnavailableTest()
    try cdpClientRejectsRedirectWithoutFollowingTargetTest()
    try cdpClientRejectsAlternateResponseURLTest()
    try cdpClientMapsTransportAndDelayedResponsesToUnavailableTest()
    try cdpStubCancelsDelayedCallbacksBeforeLaterTestStateTest()
    try cdpClientRejectsMissingVersionFieldsTest()
    try cdpClientRejectsMalformedVersionJSONTest()
    try cdpClientRejectsNonChromeBrowserTest()
    try cdpClientRejectsUnsafeWebSocketURLsTest()
    try cdpClientAcceptsDocumentedLoopbackWebSocketHostsTest()
    try cdpClientRejectsMalformedTargetListTest()
    try cdpClientReportsZeroPagesWhenOnlyNonPageTargetsExistTest()
    try cdpClientCreatesBlankTargetWithFixedPutEndpointTest()
    try cdpClientMapsCreateHTTPTransportAndRedirectFailuresTest()
    try cdpClientRejectsMalformedCreateJSONTest()
    try cdpClientRejectsNonPageBlankTargetResponseTest()
}

func registerCDPClientTests(_ runner: inout TestRunner) {
    runner.register("CDPClientTests", cdpClientTests)
    runner.register("CDPClientTests.TestSupportTimesOutAndCancelsHangingOperations", testSupportTimesOutAndCancelsHangingOperationsTest)
    runner.register("CDPClientTests.TestSupportContainsNonCooperativeTimeoutInChildProcess", testSupportContainsNonCooperativeTimeoutInChildProcessTest)
    runner.register("CDPClientTests.AcceptsChromeVersionAndCountsOnlyPageTargets", cdpClientAcceptsChromeVersionAndCountsOnlyPageTargetsTest)
    runner.register("CDPClientTests.UsesOnlyFixedSecureVersionAndListRequests", cdpClientUsesOnlyFixedSecureVersionAndListRequestsTest)
    runner.register("CDPClientTests.MapsVersionAndListHTTPFailuresToUnavailable", cdpClientMapsVersionAndListHTTPFailuresToUnavailableTest)
    runner.register("CDPClientTests.RejectsRedirectWithoutFollowingTarget", cdpClientRejectsRedirectWithoutFollowingTargetTest)
    runner.register("CDPClientTests.RejectsAlternateResponseURL", cdpClientRejectsAlternateResponseURLTest)
    runner.register("CDPClientTests.MapsTransportAndDelayedResponsesToUnavailable", cdpClientMapsTransportAndDelayedResponsesToUnavailableTest)
    runner.register("CDPClientTests.StubCancelsDelayedCallbacksBeforeLaterTestState", cdpStubCancelsDelayedCallbacksBeforeLaterTestStateTest)
    runner.register("CDPClientTests.RejectsMissingVersionFields", cdpClientRejectsMissingVersionFieldsTest)
    runner.register("CDPClientTests.RejectsMalformedVersionJSON", cdpClientRejectsMalformedVersionJSONTest)
    runner.register("CDPClientTests.RejectsNonChromeBrowser", cdpClientRejectsNonChromeBrowserTest)
    runner.register("CDPClientTests.RejectsUnsafeWebSocketURLs", cdpClientRejectsUnsafeWebSocketURLsTest)
    runner.register("CDPClientTests.AcceptsDocumentedLoopbackWebSocketHosts", cdpClientAcceptsDocumentedLoopbackWebSocketHostsTest)
    runner.register("CDPClientTests.RejectsMalformedTargetList", cdpClientRejectsMalformedTargetListTest)
    runner.register("CDPClientTests.ReportsZeroPagesWhenOnlyNonPageTargetsExist", cdpClientReportsZeroPagesWhenOnlyNonPageTargetsExistTest)
    runner.register("CDPClientTests.CreatesBlankTargetWithFixedPutEndpoint", cdpClientCreatesBlankTargetWithFixedPutEndpointTest)
    runner.register("CDPClientTests.MapsCreateHTTPTransportAndRedirectFailures", cdpClientMapsCreateHTTPTransportAndRedirectFailuresTest)
    runner.register("CDPClientTests.RejectsMalformedCreateJSON", cdpClientRejectsMalformedCreateJSONTest)
    runner.register("CDPClientTests.RejectsNonPageBlankTargetResponse", cdpClientRejectsNonPageBlankTargetResponseTest)
}
