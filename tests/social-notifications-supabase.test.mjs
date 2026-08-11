import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";

// Supabase 服务是 RPC 转发薄壳：通知聚合/撤销/禁止自我通知语义由 DB 测试
// （social-notifications-db.test.mjs）与演示服务测试（social-notifications-service.test.mjs）
// 覆盖。本文件用 clientOverride fake client 验证「方法 → RPC 名/参数」映射与字段重命名
// （next_cursor→nextCursor、like_count→likeCount、user_pen_name/user_role 补全）。
// 改造前 toggleLike/addComment 直连 likes/comments 表，fake 对非 profiles 表一律
// 返回「直接表访问已撤销」，因此改造前这些用例会失败。
function makeFakeClient() {
  const invoked = [];
  const errorResult = {
    data: null,
    error: { message: "direct table access revoked" },
  };
  const profile = { id: "u-1", pen_name: "松声", bio: "", role: "member" };
  const iso = "2026-08-10T12:00:00+08:00";
  const responses = {
    follow_user: { follower_id: "u-1", following_id: "u-2" },
    unfollow_user: null,
    bookmark_work: { user_id: "u-1", work_id: "work-1" },
    unbookmark_work: null,
    like_comment: { user_id: "u-1", comment_id: "c-1" },
    unlike_comment: null,
    toggle_like_work: { liked: true, like_count: 3 },
    create_comment: {
      id: "c-9",
      work_id: "work-1",
      user_id: "u-1",
      parent_id: null,
      content: "好文",
      is_deleted: false,
      created_at: iso,
    },
    list_notifications: {
      notifications: [
        {
          id: "n-1",
          event_type: "follow",
          target_work_id: null,
          target_comment_id: null,
          actor_pen_names: ["白露"],
          actor_count: 1,
          last_event_at: iso,
          is_read: false,
          work_title: null,
          comment_work_id: null,
        },
      ],
      next_cursor: "Y3Vycw",
    },
    get_notification_unread_count: { unread_count: 2 },
    mark_notification_read: null,
    mark_all_notifications_read: null,
    list_my_following: {
      following: [{ id: "u-2", pen_name: "白露", bio: "", created_at: iso }],
      next_cursor: null,
    },
    list_my_followers: {
      followers: [{ id: "u-3", pen_name: "杏雨", bio: "", created_at: iso }],
      next_cursor: null,
    },
    list_my_bookmarks: {
      bookmarks: [
        {
          id: "work-1",
          title: "河流向北",
          excerpt: "摘要",
          category: "散文",
          author_pen_name: "白露",
          created_at: iso,
        },
      ],
      next_cursor: null,
    },
    get_work_social_counts: { bookmark_count: 5, bookmarked_by_current_user: true },
    get_profile_social_counts: {
      following_count: 2,
      followers_count: 7,
      followed_by_current_user: true,
    },
    get_comment_like_state: {
      comments: [
        { comment_id: "c-1", like_count: 1, liked_by_current_user: true },
        { comment_id: "c-2", like_count: 0, liked_by_current_user: false },
      ],
    },
  };
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: {
              id: "u-1",
              email: "2023123456@accounts.wenyuan.invalid",
            },
          },
        },
        error: null,
      }),
    },
    from: (table) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: profile, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            single: async () => errorResult,
            maybeSingle: async () => errorResult,
          }),
        }),
        insert: async () => errorResult,
        delete: async () => errorResult,
        update: async () => errorResult,
      };
    },
    functions: {
      invoke: async (name, { body }) => {
        invoked.push([name, body]);
        if (name === "account-email" && body.action === "status") {
          return {
            data: {
              state: "verified",
              maskedEmail: "s***g@e***e.com",
              nextSendAt: null,
            },
            error: null,
          };
        }
        return { data: {}, error: null };
      },
    },
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name in responses) {
        return { data: responses[name], error: null };
      }
      return { data: null, error: { message: "unknown rpc: " + name } };
    },
  };
  return { fakeClient, invoked };
}

function supabaseService() {
  const { fakeClient, invoked } = makeFakeClient();
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  return { service, invoked };
}

test("Supabase 服务：关注/取关转发 follow_user/unfollow_user", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const followed = await service.followUser("u-2");
  assert.deepEqual(followed, { follower_id: "u-1", following_id: "u-2" });
  assert.deepEqual(invoked.at(-1), [
    "follow_user",
    { p_target_user_id: "u-2" },
  ]);

  await service.unfollowUser("u-2");
  assert.deepEqual(invoked.at(-1), [
    "unfollow_user",
    { p_target_user_id: "u-2" },
  ]);
});

test("Supabase 服务：收藏/取消转发 bookmark_work/unbookmark_work", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const bookmarked = await service.bookmarkWork("work-1");
  assert.deepEqual(bookmarked, { user_id: "u-1", work_id: "work-1" });
  assert.deepEqual(invoked.at(-1), ["bookmark_work", { p_work_id: "work-1" }]);

  await service.unbookmarkWork("work-1");
  assert.deepEqual(invoked.at(-1), ["unbookmark_work", { p_work_id: "work-1" }]);
});

test("Supabase 服务：评论点赞转发 like_comment/unlike_comment", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const liked = await service.likeComment("c-1");
  assert.deepEqual(liked, { user_id: "u-1", comment_id: "c-1" });
  assert.deepEqual(invoked.at(-1), ["like_comment", { p_comment_id: "c-1" }]);

  await service.unlikeComment("c-1");
  assert.deepEqual(invoked.at(-1), ["unlike_comment", { p_comment_id: "c-1" }]);
});

test("Supabase 服务：作品点赞迁移 toggle_like_work，like_count→likeCount", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const result = await service.toggleLike("work-1");
  assert.deepEqual(result, { liked: true, likeCount: 3 });
  assert.deepEqual(invoked.at(-1), ["toggle_like_work", { p_work_id: "work-1" }]);
});

test("Supabase 服务：评论迁移 create_comment，补全 user_pen_name/user_role", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const top = await service.addComment("work-1", "好文");
  assert.equal(top.id, "c-9");
  assert.equal(top.user_pen_name, "松声");
  assert.equal(top.user_role, "member");
  assert.deepEqual(invoked.at(-1), [
    "create_comment",
    { p_work_id: "work-1", p_content: "好文", p_parent_id: null },
  ]);

  await service.addComment("work-1", "回复", "c-1");
  assert.deepEqual(invoked.at(-1), [
    "create_comment",
    { p_work_id: "work-1", p_content: "回复", p_parent_id: "c-1" },
  ]);
});

test("Supabase 服务：通知列表 next_cursor→nextCursor", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const page = await service.listNotifications();
  assert.equal(page.notifications.length, 1);
  assert.equal(page.notifications[0].event_type, "follow");
  assert.deepEqual(page.notifications[0].actor_pen_names, ["白露"]);
  assert.equal(page.nextCursor, "Y3Vycw");
  assert.equal("next_cursor" in page, false);
  assert.deepEqual(invoked.at(-1), [
    "list_notifications",
    { p_cursor: null, p_page_size: 20 },
  ]);

  await service.listNotifications("cur", 5);
  assert.deepEqual(invoked.at(-1), [
    "list_notifications",
    { p_cursor: "cur", p_page_size: 5 },
  ]);
});

test("Supabase 服务：未读数与标记已读", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  assert.deepEqual(await service.getNotificationUnreadCount(), {
    unread_count: 2,
  });
  assert.deepEqual(invoked.at(-1), ["get_notification_unread_count", {}]);

  await service.markNotificationRead("n-1");
  assert.deepEqual(invoked.at(-1), [
    "mark_notification_read",
    { p_notification_id: "n-1" },
  ]);

  await service.markAllNotificationsRead();
  assert.deepEqual(invoked.at(-1), ["mark_all_notifications_read", {}]);
});

test("Supabase 服务：我的关注/粉丝/收藏列表 next_cursor→nextCursor", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  const following = await service.listMyFollowing();
  assert.equal(following.following.length, 1);
  assert.equal(following.following[0].pen_name, "白露");
  assert.equal(following.nextCursor, null);
  assert.equal("next_cursor" in following, false);
  assert.deepEqual(invoked.at(-1), [
    "list_my_following",
    { p_cursor: null, p_page_size: 20 },
  ]);

  const followers = await service.listMyFollowers();
  assert.equal(followers.followers.length, 1);
  assert.equal(followers.followers[0].pen_name, "杏雨");
  assert.deepEqual(invoked.at(-1), [
    "list_my_followers",
    { p_cursor: null, p_page_size: 20 },
  ]);

  const bookmarks = await service.listMyBookmarks();
  assert.equal(bookmarks.bookmarks.length, 1);
  assert.equal(bookmarks.bookmarks[0].author_pen_name, "白露");
  assert.deepEqual(invoked.at(-1), [
    "list_my_bookmarks",
    { p_cursor: null, p_page_size: 20 },
  ]);
});

test("Supabase 服务：公开聚合计数与我的状态", async () => {
  const { service, invoked } = supabaseService();
  await service.getSession();

  assert.deepEqual(await service.getWorkSocialCounts("work-1"), {
    bookmark_count: 5,
    bookmarked_by_current_user: true,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_work_social_counts",
    { p_work_id: "work-1" },
  ]);

  assert.deepEqual(await service.getProfileSocialCounts("u-2"), {
    following_count: 2,
    followers_count: 7,
    followed_by_current_user: true,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_profile_social_counts",
    { p_profile_id: "u-2" },
  ]);

  const state = await service.getCommentLikeState(["c-1", "c-2"]);
  assert.equal(state.comments.length, 2);
  assert.deepEqual(state.comments[0], {
    comment_id: "c-1",
    like_count: 1,
    liked_by_current_user: true,
  });
  assert.deepEqual(state.comments[1], {
    comment_id: "c-2",
    like_count: 0,
    liked_by_current_user: false,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_comment_like_state",
    { p_comment_ids: ["c-1", "c-2"] },
  ]);
});

test("Supabase 服务：公开计数读取无需登录", async () => {
  const { service, invoked } = supabaseService();
  // 不调用 getSession()：getWorkSocialCounts/getProfileSocialCounts/getCommentLikeState 是公开读接口
  assert.deepEqual(await service.getWorkSocialCounts("work-1"), {
    bookmark_count: 5,
    bookmarked_by_current_user: true,
  });
  assert.deepEqual(invoked.at(-1), [
    "get_work_social_counts",
    { p_work_id: "work-1" },
  ]);
  assert.deepEqual(await service.getProfileSocialCounts("u-2"), {
    following_count: 2,
    followers_count: 7,
    followed_by_current_user: true,
  });
  const state = await service.getCommentLikeState(["c-1", "c-2"]);
  assert.equal(state.comments.length, 2);
});
