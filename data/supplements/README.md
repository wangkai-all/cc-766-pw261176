# 补录复查结果投放目录
#
# 业务流程：新的复查结果（例如新的 wave v3 jsonl）投放到此目录后，
# 在页面点击"重新加载"或重跑 pipeline 即可更新当前估计。
# 已锁定月报（见 ../reports/）的证据截止日期早于补录日期，
# reports.js 的 snapshotAt 会按 reviewDate 过滤，锁定版本数值与指纹保持不变。
#
# 当前合成数据集的 v2 补录已内置在 reviews.jsonl（reviewDate=2026-11-20）。
