export default {
  testDir: './tests',
  outputDir: './test-results',
  workers: 1,
  reporter: [['json', { outputFile: 'report.json' }]],
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: 'http://127.0.0.1:4598', trace: { mode: 'on', screenshots: false, sources: false, snapshots: true } },
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4598/', reuseExistingServer: false },
};
