# config.json v4.0 改造操作手册

> 7 块改造，每块独立 edit。改完跑 `novel_preflight_workspace` 验证。

---

## 块 1：genre 重定位

```diff
- "genre": "{X流}",
- "subGenres": [
-   "{原类型}",
-   ...
- ],
- "tagline": "...",
+ "genre": "{X流}爽文",
+ "subGenres": [
+   "{X流}爽文",
+   "{原类型}（外壳）",
+   "职业智识爽文"
+ ],
+ "_genreNote": "v4.0：定位为爽文，{原类型}只是外壳。读者翻开看的是打脸装逼，留下来追的是核心悬念。",
+ "tagline": "{爽点 + 悬念 + 终极目标的一句话}",
```

---

## 块 2：brainholePreferences

```diff
  "brainholePreferences": {
    "enabledPatterns": [
      "iceberg",
      "delayed-reveal",
      "mask-layer",
      "mirror-enemy",
+     "face-slap",
+     "flex-moment"
    ],
-   "aggressiveness": 0.25,
-   "autoApplyThreshold": 0.75,
-   "maxInjectionsPerChapter": 1,
+   "aggressiveness": 0.35,
+   "autoApplyThreshold": 0.70,
+   "maxInjectionsPerChapter": 2,
-   "note": "..."
+   "note": "v4.0：爽文定位，脑洞优先服务装逼/打脸节拍。每章 1-2 个变体，face-slap 与 flex-moment 为新增爽文专属脑洞类型。"
  }
```

---

## 块 3：qualityGates

```diff
  "qualityGates": {
    "antiAiThreshold": 0.018,
    "emotionMetronome": "strict",
    "dependencyCheck": "strict",
-   "minSatisfactionDensity": 0.00018,
-   "maxOppressionLength": 4000,
+   "minSatisfactionDensity": 0.0003,
+   "_minSatisfactionDensityNote": "v4.0：爽文定位上调，每 3333 字至少一次爽点",
+   "maxOppressionLength": 3000,
+   "_maxOppressionLengthNote": "v4.0：压抑段缩短至 3000 字，防压抑过长劝退读者",
+   "chapterEndEmotionMin": 7,
+   "_chapterEndEmotionMinNote": "v4.0：章末情绪强度 ≥ 7/10，禁止平淡过渡章",
+   "hookDensityMin": 1.0,
+   "_hookDensityMinNote": "Stage 6.5 硬门禁，每 2000 字至少 1 个钩子",
    ...
  }
```

---

## 块 4：volumes 五卷重定义

```json
"volumes": [
  {
    "id": "vol-1",
    "name": "入局·{卷一主题}",
    "chapters": [1, 20],
    "status": "in_progress",
    "emotionCurve": "爽→爽→爽→爽→钩子",
    "coreGoal": "黄金三章 + 首事件单元通关 + 首次打脸 + 金手指显形",
    "availableHookTemplates": ["H1", "H3", "H4", "H8"],
    "availableActionTypes": ["A1", "A4", "A5"]
  },
  {
    "id": "vol-2",
    "name": "破局·{卷二主题}",
    "chapters": [21, 45],
    "status": "planned",
    "emotionCurve": "爽→不安→爽→真相一瞥→钩子",
    "coreGoal": "{盟友}转盟友 + 反派痕迹首次正面冲突（第30章）+ 首次反派打脸",
    "availableHookTemplates": ["H1", "H2", "H4", "H5", "H8"],
    "availableActionTypes": ["A1", "A2", "A4", "A5", "A6"]
  },
  {
    "id": "vol-3",
    "name": "深入·{卷三主题}",
    "chapters": [46, 75],
    "status": "planned",
    "emotionCurve": "爽→不安累积→失控→爽→钩子",
    "coreGoal": "真相首次浮现 + 反派化名登场（第60章）",
    "availableHookTemplates": ["H1", "H2", "H4", "H5", "H6", "H7", "H8"],
    "availableActionTypes": ["A1", "A2", "A3", "A4", "A5", "A6", "A7"]
  },
  {
    "id": "vol-4",
    "name": "真相·{卷四主题}",
    "chapters": [76, 110],
    "status": "planned",
    "emotionCurve": "压抑→压抑→爆发→真相→钩子",
    "coreGoal": "认知危机 + 反派实名（第80章）+ 身份危机（第90章）",
    "availableHookTemplates": ["H2", "H5", "H6", "H7", "H8"],
    "availableActionTypes": ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]
  },
  {
    "id": "vol-5",
    "name": "终局·{卷五主题}",
    "chapters": [111, 150],
    "status": "planned",
    "emotionCurve": "高燃→高燃→反转→释怀→封神",
    "coreGoal": "反派实战对决 + 终极副本 + 第三条路 + 封王",
    "availableHookTemplates": ["H1", "H2", "H6", "H7", "H8"],
    "availableActionTypes": ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]
  }
]
```

---

## 块 5：informationReleaseGate（4 维 × 5 卷）

```json
"informationReleaseGate": {
  "enabled": true,
  "note": "v4.0：从 10 维砍至 4 维核心 canon",
  "phases": {
    "phase1": "1-20",
    "phase2": "21-45",
    "phase3": "46-75",
    "phase4": "76-110",
    "phase5": "111-150"
  },
  "forbiddenTerms": {
    "phase1": ["{大反派实名}", "{终极组织名}", "{终极真相术语}"],
    "phase2": ["{大反派实名}", "{终极组织框架}"],
    "phase3": ["{大反派实名}"],
    "phase4": ["{终极设计者}"]
  }
}
```

---

## 块 6：新增 readerExperienceEnhancers / sceneTemplates / aiGenerationConstraints / archivePageBudget

```json
"readerExperienceEnhancers": {
  "enabledFromChapter": 1,
  "_note": "v4.0：从第 1 章即启用，不再等到第 5/20 章",
  "debtLedgerActive": true,
  "readerExpectationFromChapter": 1,
  "threeClocksActive": true,
  "openingHookSentenceRequired": true,
  "authorNoteAppendAtChapterEnd": true,
  "authorNoteWordRange": [80, 120],
  "recapEveryNChapters": 10,
  "volumeGuideOnFirstChapter": true,
  "characterNetworkAutoUpdate": true,
  "earlyRottingDetectionFromChapter": 120
},

"sceneTemplates": {
  "hookTemplatesPath": "series/scene-templates.md",
  "dungeonDesignPath": "series/design-card-template.md",
  "chapterEndHookCount": 8,
  "flexTemplateCount": 6,
  "faceSlapTemplateCount": 4,
  "dungeonArchetypeCount": 5,
  "breakthroughActionCount": 8
},

"aiGenerationConstraints": {
  "chapterMustClose": true,
  "maxDungeonChapterLength": 5,
  "maxSimultaneousSpeakers": 3,
  "protagonistSoloInVolume1": true,
  "maxCrossVolumeForeshadows": 6,
  "maxSameActionConsecutive": 2,
  "mainCharsPerChapterMax": 3
},

"archivePageBudget": {
  "totalAllowed": 6,
  "used": 0,
  "earliestChapter": 25,
  "injectChapters": [25, 50, 75, 100, 125, 145],
  "note": "档案残页机制（取代旧的代码短闪）。AI 生成友好的文本块。"
}
```

---

## 块 7：废弃旧字段

如有以下字段，标记为废弃：

```diff
  "codeFlashBudget": {
-   "totalAllowed": 3,
-   "earliestChapter": 56,
+   "totalAllowed": 0,
+   "earliestChapter": 99999,
+   "_v4Note": "v4.0：已下线，被 archivePageBudget 取代",
    "note": "已废弃。用 archivePageBudget 替代。"
  }
```

---

## 改完必跑

```
novel_preflight_workspace { workspaceId, chapterId: 下一章号, chapterNumber }
```

**期望**：`status: passed`，`seedReadiness.score: 100`，无 blockingItems。
