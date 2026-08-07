class SlowTestReporter {
  constructor(globalConfig, options) {
    this._globalConfig = globalConfig;
    this._options = options;
    this.slowThreshold = (options && options.slowThreshold) || 2000; // Default 2 seconds
  }

  onTestResult(test, testResult) {
    const slowTests = [];
    
    testResult.testResults.forEach((result) => {
      if (result.duration > this.slowThreshold) {
        slowTests.push({
          title: result.title,
          duration: result.duration,
          fullName: result.fullName || result.title,
          ancestorTitles: result.ancestorTitles
        });
      }
    });

    if (slowTests.length > 0) {
      console.log(`\n🐌 Slow tests in ${test.path.split('/').pop()}:`);
      slowTests.forEach((test) => {
        const testPath = test.ancestorTitles.length > 0 
          ? `${test.ancestorTitles.join(' › ')} › ${test.title}`
          : test.title;
        console.log(`  ⏱️  ${(test.duration / 1000).toFixed(2)}s - ${testPath}`);
      });
    }
  }

  onRunComplete(contexts, results) {
    console.log('\n📊 Test Performance Summary:');
    console.log(`   Total test suites: ${results.numTotalTestSuites}`);
    console.log(`   Total tests: ${results.numTotalTests}`);
    console.log(`   Total time: ${((Date.now() - results.startTime) / 1000).toFixed(2)}s`);
    
    // Collect all slow tests across all test files
    const allSlowTests = [];
    results.testResults.forEach((testFileResult) => {
      testFileResult.testResults.forEach((test) => {
        if (test.duration > this.slowThreshold) {
          allSlowTests.push({
            file: testFileResult.testFilePath.split('/').pop(),
            title: test.title,
            duration: test.duration,
            fullName: test.ancestorTitles.length > 0 
              ? `${test.ancestorTitles.join(' › ')} › ${test.title}`
              : test.title
          });
        }
      });
    });

    if (allSlowTests.length > 0) {
      console.log(`\n🐌 All tests slower than ${this.slowThreshold / 1000}s:`);
      allSlowTests
        .sort((a, b) => b.duration - a.duration)
        .forEach((test) => {
          console.log(`   ${(test.duration / 1000).toFixed(2)}s - ${test.file} - ${test.fullName}`);
        });
    }
  }
}

module.exports = SlowTestReporter;