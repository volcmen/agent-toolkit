import Darwin
import ChromeCDPTestSupport

var runner = TestRunner()
registerLauncherConfigurationTests(&runner)
registerLauncherClassifierTests(&runner)
registerLauncherFailureTests(&runner)
runner.register("ChromeCDPCoreTests") {
    try launcherConfigurationProductionTest()
    try launcherClassifierTests()
    try launcherFailureTests()
}
exit(Int32(runner.run(arguments: CommandLine.arguments)))
