import ChromeCDPCore
import Foundation

public protocol CDPServicing: Sendable {
    func inspect(configuration: LauncherConfiguration) async -> EndpointObservation
    func createBlankTarget(configuration: LauncherConfiguration) async throws
}

public enum CDPClientError: Error, Equatable, Sendable {
    case requestFailed
    case malformedCreateResponse
}

public struct CDPClient: CDPServicing, Sendable {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 0.1
            configuration.timeoutIntervalForResource = 0.1
            configuration.httpShouldSetCookies = false
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
    }

    public func inspect(configuration: LauncherConfiguration) async -> EndpointObservation {
        let versionData: Data
        do {
            versionData = try await request(url: try endpointURL(configuration: configuration, path: "/json/version"), method: "GET", configuration: configuration)
        } catch {
            return .unavailable
        }

        guard let version = jsonObject(versionData),
              let browser = version["Browser"] as? String,
              let debuggerURLString = version["webSocketDebuggerUrl"] as? String,
              let debuggerURL = URL(string: debuggerURLString) else {
            return .invalid(.malformedVersion)
        }
        guard browser.hasPrefix("Chrome/") else {
            return .invalid(.nonChromeBrowser)
        }
        if let failure = validateWebSocket(debuggerURL, configuredPort: configuration.port) {
            return .invalid(failure)
        }

        let targetData: Data
        do {
            targetData = try await request(url: try endpointURL(configuration: configuration, path: "/json/list"), method: "GET", configuration: configuration)
        } catch {
            return .unavailable
        }
        guard let targets = jsonArray(targetData) else {
            return .invalid(.malformedTargetList)
        }
        var pageTargetCount = 0
        for target in targets {
            guard let type = target["type"] as? String else {
                return .invalid(.malformedTargetList)
            }
            if type == "page" {
                pageTargetCount += 1
            }
        }
        return .healthy(webSocketURL: debuggerURL, pageTargetCount: pageTargetCount)
    }

    public func createBlankTarget(configuration: LauncherConfiguration) async throws {
        let url = try endpointURL(configuration: configuration, path: "/json/new", query: "about:blank")
        let data = try await request(url: url, method: "PUT", configuration: configuration)
        guard let target = jsonObject(data), target["type"] as? String == "page" else {
            throw CDPClientError.malformedCreateResponse
        }
    }

    private func request(url: URL, method: String, configuration: LauncherConfiguration) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = requestTimeout(for: configuration)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await requestData(request, timeout: request.timeoutInterval)
        } catch let cancellation as CancellationError {
            throw cancellation
        } catch {
            try Task.checkCancellation()
            throw CDPClientError.requestFailed
        }
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200,
              response.url == url else {
            throw CDPClientError.requestFailed
        }
        return data
    }

    private func requestData(_ request: URLRequest, timeout: TimeInterval) async throws -> (Data, URLResponse) {
        try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask {
                try await session.data(for: request, delegate: NoRedirectDelegate())
            }
            group.addTask {
                try await Task.sleep(for: .seconds(timeout))
                throw CDPClientError.requestFailed
            }
            guard let result = try await group.next() else {
                throw CDPClientError.requestFailed
            }
            group.cancelAll()
            return result
        }
    }

    private func endpointURL(configuration: LauncherConfiguration, path: String, query: String? = nil) throws -> URL {
        guard ["127.0.0.1", "localhost", "::1"].contains(configuration.host),
              (1...65_535).contains(configuration.port),
              configuration.pollInterval > 0 else {
            throw CDPClientError.requestFailed
        }
        var components = URLComponents()
        components.scheme = "http"
        components.host = configuration.host
        components.port = configuration.port
        components.path = path
        components.percentEncodedQuery = query
        guard let url = components.url else {
            throw CDPClientError.requestFailed
        }
        return url
    }

    private func requestTimeout(for configuration: LauncherConfiguration) -> TimeInterval {
        min(0.1, configuration.pollInterval / 2)
    }

    private func jsonObject(_ data: Data) -> [String: Any]? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            return nil
        }
        return dictionary
    }

    private func jsonArray(_ data: Data) -> [[String: Any]]? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let array = object as? [[String: Any]] else {
            return nil
        }
        return array
    }

    private func validateWebSocket(_ url: URL, configuredPort: Int) -> EndpointFailure? {
        guard url.scheme == "ws" || url.scheme == "wss" else {
            return .invalidWebSocket
        }
        guard url.user == nil, url.password == nil,
              let host = url.host,
              ["127.0.0.1", "localhost", "::1"].contains(host) else {
            return .nonLoopbackWebSocket
        }
        guard url.port == configuredPort else {
            return .wrongWebSocketPort
        }
        return nil
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _: URLSession,
        task _: URLSessionTask,
        willPerformHTTPRedirection _: HTTPURLResponse,
        newRequest _: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}
