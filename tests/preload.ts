// 测试默认跑中文:现有断言按中文文案写,CI 机器的 LANG 却是英文。英文输出由 i18n.test.ts 切换语言后单独测。
process.env["ZGATE_LANG"] = "zh";
