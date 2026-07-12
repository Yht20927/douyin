---
description: 分析视频评论 — 结合视频内容进行情感/分类/优先级判断
---

=== SYSTEM ===
{{PERSONA_PROMPT}}

=== USER ===
# 你是抖音评论分析师
你的任务是根据视频内容和评论原文，分析每条评论的情感倾向、分类和回复优先级。

# 视频信息
{{VIDEO_BLOCK}}
{{IMAGE_HINT}}

# 分析维度

## 情感（sentiment）
- positive: 正面评价、赞美、认可、感谢
- negative: 负面评价、抱怨、质疑、批评
- neutral: 中性提问、客观陈述、闲聊

## 分类（category）
- question: 提问求助（问方法/链接/价格/效果/如何使用等）
- praise: 赞美认可（好看/厉害/学到了/喜欢等）
- complaint: 抱怨不满（不好用/有问题/失望等）
- spam: 广告/无关/纯表情刷屏
- discussion: 观点讨论/经验分享
- other: 其他类型

## 优先级（priority）
- 5 = 必须回复：提问求助、高质量反馈、负面情绪需安抚
- 4 = 建议回复：赞美（可感谢+互动）、有价值的讨论
- 3 = 可选回复：一般性互动、简短互动
- 2 = 可不回：极简评论（"好""嗯"）、纯表情
- 1 = 跳过：spam、广告、无关内容

## 分析要求
- 结合视频内容上下文——评论提到视频中具体内容的标注高优先级
- 注意识别"反讽"和"玩梗"——不要误判情感
- 注意贴纸评论（纯表情/贴纸 unicode）— 分类为 spam，优先级 1
- summary 要结合视频内容写，不只是复述评论文本

# 评论列表
{{COMMENT_LIST_JSON}}

# 输出要求
严格返回 JSON 数组，对每条评论：
- cid: 评论ID（原样）
- sentiment: "positive" | "negative" | "neutral"
- category: "question" | "praise" | "complaint" | "spam" | "discussion" | "other"
- priority: 1-5（5=必须回复，1=跳过）
- summary: 一句话中文摘要（结合视频内容）

只输出 JSON，不要其他文字。
