import ChromeCDPMac
import Darwin
import Foundation

@main
struct ChromeCDPInstallerMain {
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 5,
              arguments[0] == "publish",
              arguments[1] == "--staged",
              arguments[3] == "--installed" else {
            fail("usage: chrome-cdp-installer publish --staged STAGED.app --installed INSTALLED.app", status: 64)
        }

        let applications = URL(fileURLWithPath: "/Applications", isDirectory: true).standardizedFileURL
        let staged = URL(fileURLWithPath: arguments[2]).standardizedFileURL
        let installed = URL(fileURLWithPath: arguments[4]).standardizedFileURL
        guard installed == applications.appendingPathComponent("Chrome CDP.app", isDirectory: true),
              staged.deletingLastPathComponent() == applications,
              staged.lastPathComponent.hasPrefix(".Chrome CDP.app.stage-") else {
            fail("installer paths are outside the fixed Chrome CDP application boundary", status: 65)
        }

        do {
            let result = try AtomicBundleSwap.publish(
                staged: staged,
                installed: installed,
                allowedParent: applications
            )
            switch result {
            case .movedIntoEmptyDestination:
                print("published Chrome CDP.app")
            case .swappedExistingDestination:
                print("atomically swapped Chrome CDP.app")
            }
        } catch {
            fail("Chrome CDP.app could not be published atomically", status: 1)
        }
    }

    private static func fail(_ message: String, status: Int32) -> Never {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(status)
    }
}
