#!/usr/bin/env node
'use strict';
const { main } = require('../src/main.js');

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`启动失败：${err.message}`);
  process.exit(1);
});
