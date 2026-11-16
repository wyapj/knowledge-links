# Knowledge Links · wyapj 知识图谱

把 GitHub Star 与相关项目整理成一张可交互的知识网络：按 **基础知识 → 工程实践 → 研究项目** 三层组织，用颜色区分 AI / 大模型、机器人、自动驾驶、AI 编程基础与工程工具。

> 🌐 在线访问：<https://wyapj.github.io/knowledge-links/>
>
> 页面由 GitHub Pages 托管，无需本地运行。每天由 GitHub Actions 自动同步最新的 Star 项目。

## 功能

- **分层知识图谱**：三条水平知识带，节点按「基础知识 → 工程实践 → 研究项目」排列；虚线 / 实线 / 加粗描边分别对应不同层级。
- **高级缩放与拖拽**：滚轮以光标为中心缩放、拖拽平移、触摸双指缩放、双击节点聚焦、双击空白放大、迷你地图导航、一键适配 / 重置。
- **搜索与筛选**：支持项目名、仓库名、标签、简介、语言和领域的中英文搜索；按分层与领域多选筛选；搜索结果可直接定位。
- **知识图谱仪表盘**：KPI 概览、分层占比、领域分布、最近 Star、项目详情、关键关联、自动同步状态。
- **自动纳入新 Star**：GitHub Actions 每天抓取 `wyapj` 的 Star 列表写入 `data/starred.json`；页面加载快照，新项目会自动归类并加入图谱。页面上的「同步 GitHub」按钮也可即时拉取。
- **自动归类**：新增项目根据仓库描述、语言与 topics 的关键词规则自动判断分层与领域；可在 `js/curated.js` 中人工校正。

## 数据与文件

```text
index.html                 页面骨架
css/styles.css             仪表盘与图谱视觉
js/curated.js              80 个项目的领域/分层/中文简介/标签，以及语义关联边
js/app.js                  布局、渲染、缩放拖拽、搜索筛选、同步逻辑
data/starred.json          GitHub Star 快照（GitHub Actions 每日更新）
.github/workflows/         Pages 部署 + Star 自动同步
```

图谱布局是确定性的：先按分层与领域划分水平区段，再用受约束的力导向算法微调位置。新增 Star 会进入对应分层与领域区段，并与同类项目自动建立关联边。

## 在 GitHub 上直接打开（一次性配置）

1. 打开仓库 **Settings → Pages**，把 **Source** 设为 **GitHub Actions**。
2. 打开 **Settings → Actions → General**，确认 **Workflow permissions** 允许 **Read and write permissions**（自动同步需要提交快照）。
3. 进入 **Actions**，手动运行一次 **Deploy GitHub Pages** 和 **Sync GitHub Stars**。
4. 可选：在仓库首页 **About → Website** 填入下方地址，之后可以直接从 GitHub 仓库页打开网页。

完成后即可访问：

```text
https://wyapj.github.io/knowledge-links/
```

之后：
- 每天 `02:23 UTC` 自动同步 Star 快照；
- 同步产生提交后，Pages 工作流会自动重新部署；
- 你新 Star 的公开项目最迟第二天出现在图谱里，也可以随时点击页面右上角「同步 GitHub」立即更新。

## 本地预览（可选）

```bash
python3 -m http.server 8000
```

打开 <http://localhost:8000>。直接双击 `index.html` 也能查看内置精选数据，但浏览器可能限制读取 `data/starred.json`。

## 人工校正

编辑 `js/curated.js` 中对应仓库的条目即可调整：

```js
{
  "full_name": "ros-navigation/navigation2",
  "layer": "engineering",        // foundation | engineering | research
  "category": "robotics",        // llm | robotics | driving | fundamentals | tools
  "summary": "……",
  "tags": ["ROS2", "导航", "规划"]
}
```

`edges` 数组维护语义关联（使用 `owner/repo` 全名）。未手工配置的项目会自动归类并连接到同类节点，因此新 Star 不会成为孤岛。

## 说明

- 页面读取的 Star 快照只包含公开仓库；私有 Star 不会展示。
- 页面内「同步 GitHub」使用未登录的 GitHub API，受每 IP 每小时 60 次限制；失败时会自动回退到仓库快照。
- 本图谱用于整理学习路线、项目脉络与研究入口，节点间的连线表示知识关联而非严格依赖。
