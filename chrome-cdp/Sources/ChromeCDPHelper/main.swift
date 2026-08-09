import Darwin
import Foundation

if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--version" {
    print("chrome-cdp-helper 1.0.0")
} else {
    let message = "error: only --version is supported\n"
    FileHandle.standardError.write(Data(message.utf8))
    exit(64)
}
