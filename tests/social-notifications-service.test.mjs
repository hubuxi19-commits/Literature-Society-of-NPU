import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";
import { demoSeed } from "../js/demo-data.mjs";

const SIGN = {
  pine: { studentNumber: "2023123456", password: "wenyuan88" }, // 松声
  editor: { studentNumber: "2023000001", password: "editor88" }, // 编辑部
  dew: { studentNumber: "2022111111", password: "reader88" }, // 白露
};

// 清空演示社交状态，让测试从零构建（不依赖 demo-data 的种子社交数据）。
// 演示服务是单会话内存态，多用户交互通过切换登录（signIn 覆盖会话）模拟。
function freshSeed() {
  const seed = structuredClone(demoSeed);
  seed.follows = [];
  seed.bookmarks = [];
  seed.commentLikes = [];
  seed.notifications = [];
  return seed;
}

function demoService() {
  return createDataService({ mode: "demo", seed: freshSeed() });
}

const ofType = (serviceItems, eventType) =>
  serviceItems.notifications.filter((n) => n.event_type === eventType);

test("演示模式：关注往返产生聚合通知，取关撤销通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  const followed = await service.followUser("profile-dew");
  assert.deepEqual(followed, {
    follower_id: "profile-pine",
    following_id: "profile-dew",
  });
  // 幂等：重复关注返回相同结果，不重复计数
  const again = await service.followUser("profile-dew");
  assert.equal(again.following_id, "profile-dew");

  // 松声关注列表
  assert.equal((await service.listMyFollowing()).following.length, 1);
  assert.equal(
    (await service.listMyFollowing()).following[0].pen_name,
    "白露",
  );

  // 切到白露：收到一条 follow 聚合通知 + 粉丝列表可见
  await service.signIn(SIGN.dew);
  const dewNotifs = ofType(await service.listNotifications(), "follow");
  assert.equal(dewNotifs.length, 1);
  assert.equal(dewNotifs[0].actor_count, 1);
  assert.deepEqual(dewNotifs[0].actor_pen_names, ["松声"]);
  assert.equal((await service.listMyFollowers()).followers.length, 1);
  assert.equal(
    (await service.listMyFollowers()).followers[0].id,
    "profile-pine",
  );

  // 切回松声取关 → 白露的 follow 通知消失
  await service.signIn(SIGN.pine);
  await service.unfollowUser("profile-dew");
  assert.equal((await service.listMyFollowing()).following.length, 0);
  await service.signIn(SIGN.dew);
  assert.equal(ofType(await service.listNotifications(), "follow").length, 0);
});

test("演示模式：禁止自我关注", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  await assert.rejects(() => service.followUser("profile-pine"), /不能关注自己/);
  await assert.rejects(() => service.followUser("no-such-user"), /关注对象不存在/);
});

test("演示模式：收藏往返产生 work_bookmark 通知，取消撤销", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声收藏白露的《河流向北》
  const bookmarked = await service.bookmarkWork("work-river");
  assert.deepEqual(bookmarked, {
    user_id: "profile-pine",
    work_id: "work-river",
  });
  const counts = await service.getWorkSocialCounts("work-river");
  assert.equal(counts.bookmark_count, 1);
  assert.equal(counts.bookmarked_by_current_user, true);
  const list = await service.listMyBookmarks();
  assert.equal(list.bookmarks.length, 1);
  assert.equal(list.bookmarks[0].title, "河流向北");
  assert.equal(list.bookmarks[0].author_pen_name, "白露");

  // 切到白露：收到 work_bookmark 通知
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_bookmark").length,
    1,
  );

  // 切回松声取消收藏 → 通知撤销
  await service.signIn(SIGN.pine);
  await service.unbookmarkWork("work-river");
  assert.equal((await service.listMyBookmarks()).bookmarks.length, 0);
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_bookmark").length,
    0,
  );
});

test("演示模式：评论点赞往返产生 comment_like 通知，禁止赞自己", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声赞白露的评论 comment-1
  const liked = await service.likeComment("comment-1");
  assert.deepEqual(liked, {
    user_id: "profile-pine",
    comment_id: "comment-1",
  });
  const state = await service.getCommentLikeState(["comment-1", "comment-3"]);
  const byId = new Map(state.comments.map((c) => [c.comment_id, c]));
  assert.equal(byId.get("comment-1").like_count, 1);
  assert.equal(byId.get("comment-1").liked_by_current_user, true);
  assert.equal(byId.get("comment-3").like_count, 0);
  assert.equal(byId.get("comment-3").liked_by_current_user, false);

  // 切到白露：收到 comment_like 通知
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "comment_like").length,
    1,
  );

  // 切回松声取消点赞 → 归零、通知撤销
  await service.signIn(SIGN.pine);
  await service.unlikeComment("comment-1");
  assert.equal(
    (await service.getCommentLikeState(["comment-1"])).comments[0].like_count,
    0,
  );
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "comment_like").length,
    0,
  );

  // 禁止赞自己：白露赞自己的 comment-1 → 被拒
  await assert.rejects(() => service.likeComment("comment-1"), /不能赞自己的评论/);
  assert.equal(
    ofType(await service.listNotifications(), "comment_like").length,
    0,
  );
});

test("演示模式：作品点赞 toggle 发/撤 work_like 通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声点赞白露的《小事记》（松声此前未点赞，作者是白露）
  const on = await service.toggleLike("work-small-things");
  assert.equal(on.liked, true);
  assert.equal(
    ofType(await service.listNotifications(), "work_like").length,
    0, // 松声是点赞者而非作者，自己不该收到
  );
  // 切到白露确认收到 work_like，切回松声取消
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_like").length,
    1,
  );
  await service.signIn(SIGN.pine);
  const off = await service.toggleLike("work-small-things");
  assert.equal(off.liked, false);
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_like").length,
    0,
  );
});

test("演示模式：评论/回复产生通知，删除评论撤销 work_comment", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);

  // 松声在《河流向北》下发顶层评论 → 白露收 work_comment
  const comment = await service.addComment(
    "work-river",
    "读完了，想去河边走走。",
  );
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_comment").length,
    1,
  );
  // 白露回复松声 → 松声收 comment_reply
  await service.addComment("work-river", "欢迎来。", comment.id);
  await service.signIn(SIGN.pine);
  assert.equal(
    ofType(await service.listNotifications(), "comment_reply").length,
    1,
  );
  // 松声删除顶层评论 → 白露的 work_comment 撤销（回复通知不受影响）
  await service.deleteComment(comment.id);
  await service.signIn(SIGN.dew);
  assert.equal(
    ofType(await service.listNotifications(), "work_comment").length,
    0,
  );
  await service.signIn(SIGN.pine);
  assert.equal(
    ofType(await service.listNotifications(), "comment_reply").length,
    1,
  );
});

test("演示模式：同类事件折叠 +N，actor 头为最近者且按序解析笔名", async () => {
  const service = demoService();
  // 白露、编辑部都收藏《末班车经过友谊校区》（作者松声）
  await service.signIn(SIGN.dew);
  await service.bookmarkWork("work-night-bus");
  await service.signIn(SIGN.editor);
  await service.bookmarkWork("work-night-bus");
  // 切到松声：只收到一条折叠后的 work_bookmark 通知
  await service.signIn(SIGN.pine);
  const items = ofType(await service.listNotifications(), "work_bookmark");
  assert.equal(items.length, 1);
  assert.equal(items[0].actor_count, 2);
  assert.deepEqual(items[0].actor_pen_names, ["编辑部", "白露"]);
  assert.equal(items[0].target_work_id, "work-night-bus");
  assert.equal(items[0].work_title, "末班车经过友谊校区");
});

test("演示模式：通知未读数与标记已读", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  // 松声收藏《河流向北》、点赞《小事记》→ 白露收 2 条通知
  await service.bookmarkWork("work-river");
  await service.toggleLike("work-small-things");
  await service.signIn(SIGN.dew);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 2);
  const list = (await service.listNotifications()).notifications;
  assert.equal(list.length, 2);
  await service.markNotificationRead(list[0].id);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 1);
  await service.markAllNotificationsRead();
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 0);
});

test("演示模式：getProfileSocialCounts 计数公开 + 我的关注态", async () => {
  // 用默认演示种子（含预置关注关系：松声、杏雨关注白露），匿名视角计数公开
  const anon = createDataService({ mode: "demo" });
  const anonCounts = await anon.getProfileSocialCounts("profile-dew");
  assert.equal(anonCounts.followers_count, 2);
  assert.equal(anonCounts.followed_by_current_user, false);

  const service = createDataService({ mode: "demo" });
  await service.signIn(SIGN.pine);
  // 松声视角：种子中松声已关注白露 → followed_by_current_user 为 true
  const counts = await service.getProfileSocialCounts("profile-dew");
  assert.equal(counts.followers_count, 2);
  assert.equal(counts.following_count, 1);
  assert.equal(counts.followed_by_current_user, true);
  // 动作：松声再关注杏雨 → 杏雨粉丝数 +1
  await service.followUser("profile-apricot");
  assert.equal(
    (await service.getProfileSocialCounts("profile-apricot")).followers_count,
    1,
  );
});

test("演示模式：cap-3 聚合 —— 4 个 actor 折叠为 3，头部为最近者", async () => {
  // 默认种子只有 3 个可登录账号，达不到 cap-3；注入杏雨、原上两个账号做 4 人聚合。
  const seed = structuredClone(demoSeed);
  seed.accounts.push(
    { studentNumber: "2024000001", password: "apricot88", profileId: "profile-apricot" },
    { studentNumber: "2024000002", password: "wild88", profileId: "profile-wild" },
  );
  seed.follows = [];
  seed.bookmarks = [];
  seed.commentLikes = [];
  seed.notifications = [];
  const service = createDataService({ mode: "demo", seed });
  const SIGN_APRICOT = { studentNumber: "2024000001", password: "apricot88" };
  const SIGN_WILD = { studentNumber: "2024000002", password: "wild88" };
  // 4 个不同用户依次关注白露：editor → wild → apricot → pine（越晚者越“近”）
  await service.signIn(SIGN.editor);
  await service.followUser("profile-dew");
  await service.signIn(SIGN_WILD);
  await service.followUser("profile-dew");
  await service.signIn(SIGN_APRICOT);
  await service.followUser("profile-dew");
  await service.signIn(SIGN.pine);
  await service.followUser("profile-dew");
  // 白露视角：一条 follow 通知，actor 折叠为 3，头为最近者（松声），计数为 4
  await service.signIn(SIGN.dew);
  const items = ofType(await service.listNotifications(), "follow");
  assert.equal(items.length, 1);
  assert.equal(items[0].actor_count, 4);
  assert.equal(items[0].actor_pen_names.length, 3);
  assert.deepEqual(items[0].actor_pen_names, ["松声", "杏雨", "原上"]);
});

test("演示模式：markNotificationRead 只能标记本人通知", async () => {
  const service = demoService();
  await service.signIn(SIGN.pine);
  // 松声收藏《河流向北》、点赞《小事记》→ 白露收 2 条未读
  await service.bookmarkWork("work-river");
  await service.toggleLike("work-small-things");
  await service.signIn(SIGN.dew);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 2);
  const dewNotifs = (await service.listNotifications()).notifications;
  // 松声尝试标记白露的通知 → 白露未读数不变（与 SQL mark_notification_read 的 user_id 过滤一致）
  await service.signIn(SIGN.pine);
  await service.markNotificationRead(dewNotifs[0].id);
  await service.signIn(SIGN.dew);
  assert.equal((await service.getNotificationUnreadCount()).unread_count, 2);
});
