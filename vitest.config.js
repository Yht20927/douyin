// vitest.config.js
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    // 测试不阻塞于 risk-control 节奏守卫（间隔由单测自行 mock / 不依赖 wall-clock）
    env: {
      DOUYIN_NO_THROTTLE: '1',
    },
  },
});
