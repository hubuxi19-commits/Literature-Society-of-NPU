import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";
import { demoSeed } from "../js/demo-data.mjs";

const SIGN = {
  pine: { studentNumber: "2023123456", password: "wenyuan88" }, // 松声 (member)
  editor: { studentNumber: "2023000001", password: "editor88" }, // 编辑部 (admin)
  dew: { studentNumber: "2022111111", password: "reader88" }, // 白露 (member)
};

function freshSeed() {
  const seed = structuredClone(demoSeed);
  seed.follows = [];
  seed.bookmarks = [];
  seed.commentLikes = [];
  seed.notifications = [];
  seed.reports = [];
  seed.moderationActions = [];
  seed.editorialNotes = [];
  seed.commentHighlights = [];
  return seed;
}

function demoService() {
  return createDataService({ mode: "demo", seed: freshSeed() });
}

const ofType = (serviceItems, eventType) =>
  serviceItems.notifications.filter((n) => n.event_type === eventType);

test("演示模式：举报往返、幂等、禁止自举报", async () => {
  const service = demoService();
  await service.signIn(SIGN.dew);
  const reported = await service.reportContent("work", "work-night-bus", "violation", "疑似抄袭");
  assert.equal(reported.status, "reported");
  const again = await service.reportContent("work", "work-night-bus", "violation", "再报");
  assert.equal(again.status, "already_reported");
  // 白露是 work-night-bus 的作者松声之外的读者；松声自举报被拒
  await service.signIn(SIGN.pine);
  await assert.rejects(
    () => service.reportContent("work", "work-night-bus", "violation", "x"),
    /不能举报自己的内容/,
  );
});

test("演示模式：管理员处置成立隐藏作品并写审计，作者收到处置通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.dew);
  await service.reportContent("work", "work-night-bus", "violation", "内容违规");
  // 处置台仅管理员可见，切换到编辑部账号查看待处置列表
  await service.signIn(SIGN.editor);
  const { reports } = await service.listReports("pending");
  assert.equal(reports.length, 1);
  // 非管理员处置被拒
  await service.signIn(SIGN.pine);
  await assert.rejects(
    () => service.moderateReport(reports[0].id, "resolved", "hide_work", "确认"),
    /没有权限/,
  );
  // 管理员处置成立
  await service.signIn(SIGN.editor);
  const acted = await service.moderateReport(reports[0].id, "resolved", "hide_work", "确认违规");
  assert.equal(acted.status, "resolved");
  assert.equal(acted.action_type, "hide_work");
  const { actions } = await service.listModerationActions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].internal_note, "确认违规");
  assert.equal(actions[0].admin_pen_name, "编辑部");
  // 作品已隐藏（公开读取被排除）
  await assert.rejects(
    () => service.getWork("work-night-bus"),
    /作品不存在/,
  );
  // 作者松声收到处置结果通知（含决策不含内部说明）
  await service.signIn(SIGN.pine);
  const outcomes = ofType(await service.listNotifications(), "moderation_outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.decision, "resolved");
  assert.equal(outcomes[0].payload.action_type, "hide_work");
  assert.ok(!JSON.stringify(outcomes[0].payload).includes("确认违规"));
});

test("演示模式：编辑点评与推荐理由——仅管理员可写，公开可读", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  await assert.rejects(
    () => service.setWorkEditorialNote("work-river", "editorial_note", "写得好"),
    /没有权限/,
  );
  await service.signIn(SIGN.editor);
  await service.setWorkEditorialNote("work-river", "recommendation_reason", "本期编辑推荐");
  await service.setWorkEditorialNote("work-river", "recommendation_reason", "新推荐语");
  const editorial = await service.getWorkEditorial("work-river");
  assert.equal(editorial.recommendation_reason.content, "新推荐语");
  assert.equal(editorial.recommendation_reason.admin_pen_name, "编辑部");
  assert.equal(editorial.editorial_note.content, null);
});

test("演示模式：优质评论推荐触发通知，取消推荐", async () => {
  const service = demoService();
  await service.signIn(SIGN.editor);
  await service.highlightComment("comment-1", "观点清晰");
  // 评论作者白露收到推荐通知
  await service.signIn(SIGN.dew);
  assert.equal(ofType(await service.listNotifications(), "comment_highlight").length, 1);
  const { highlights } = await service.getWorkHighlights("work-night-bus");
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].reason, "观点清晰");
  await service.signIn(SIGN.editor);
  await service.unhighlightComment("comment-1");
  assert.equal((await service.getWorkHighlights("work-night-bus")).highlights.length, 0);
});

test("演示模式：非管理员访问处置台列表被拒", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  await assert.rejects(() => service.listReports("pending"), /没有权限/);
  await assert.rejects(() => service.listModerationActions(), /没有权限/);
});
