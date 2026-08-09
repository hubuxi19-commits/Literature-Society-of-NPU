import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";
import { demoSeed } from "../js/demo-data.mjs";
import { PEN_NAME_CHANGE_INTERVAL_MS } from "../js/utils.mjs";

test("演示成员可以登录、发布、点赞、回复和删除自己的内容", async () => {
  const service = createDataService({ mode: "demo" });
  const session = await service.signIn({
    studentNumber: "2023123456",
    password: "wenyuan88",
  });
  assert.equal(session.profile.pen_name, "松声");
  assert.equal("student_number" in session.profile, false);

  const work = await service.createWork({
    title: "新作",
    excerpt: "摘要",
    content: "正文",
    category: "新诗",
  });
  assert.equal(work.author_id, session.profile.id);

  const classicalWork = await service.createWork({
    title: "旧体新作",
    excerpt: "摘要",
    content: "正文",
    category: "旧诗",
  });
  assert.equal(classicalWork.category, "旧诗");

  const liked = await service.toggleLike(work.id);
  assert.equal(liked.liked, true);
  assert.equal(liked.likeCount, 1);
  const unliked = await service.toggleLike(work.id);
  assert.equal(unliked.liked, false);
  assert.equal(unliked.likeCount, 0);

  const root = await service.addComment(work.id, "读过了");
  const reply = await service.addComment(work.id, "谢谢", root.id);
  assert.equal(reply.parent_id, root.id);
  await service.deleteComment(root.id);
  assert.equal(
    (await service.getWork(work.id)).comments.find(
      (item) => item.id === root.id,
    ).is_deleted,
    true,
  );

  await service.deleteWork(work.id);
  await assert.rejects(() => service.getWork(work.id), /作品不存在/);
});

test("普通成员不能删除他人作品，管理员可以", async () => {
  const member = createDataService({ mode: "demo" });
  await member.signIn({
    studentNumber: "2023123456",
    password: "wenyuan88",
  });
  await assert.rejects(() => member.deleteWork("work-river"), /没有权限/);

  const admin = createDataService({ mode: "demo" });
  await admin.signIn({
    studentNumber: "2023000001",
    password: "editor88",
  });
  await admin.deleteWork("work-river");
  await assert.rejects(() => admin.getWork("work-river"), /作品不存在/);
});

test("管理员推荐操作只返回推荐状态供前端本地更新", async () => {
  const admin = createDataService({ mode: "demo" });
  await admin.signIn({
    studentNumber: "2023000001",
    password: "editor88",
  });

  const result = await admin.setFeatured("work-river", false);
  assert.deepEqual(result, { id: "work-river", is_featured: false });
  assert.equal((await admin.getWork("work-river")).is_featured, false);
});

test("注册不会把学号写入公开资料且会话可以退出", async () => {
  const service = createDataService({ mode: "demo" });
  const session = await service.signUp({
    studentNumber: "2024555555",
    password: "newmember88",
    penName: "远岫",
  });
  assert.deepEqual(Object.keys(session.profile).sort(), [
    "bio",
    "created_at",
    "id",
    "pen_name",
    "pen_name_changed_at",
    "role",
    "updated_at",
  ]);
  await service.signOut();
  assert.equal(await service.getSession(), null);
});

test("作品列表提供作者、点赞和评论聚合字段", async () => {
  const service = createDataService({ mode: "demo" });
  const works = await service.listWorks();
  assert.ok(works.length >= 6);
  assert.equal(typeof works[0].author_pen_name, "string");
  assert.equal(typeof works[0].like_count, "number");
  assert.equal(typeof works[0].comment_count, "number");
  assert.equal(typeof works[0].liked_by_current_user, "boolean");
  assert.equal(
    typeof works[0].current_version_id,
    "string",
    "种子作品应回填真实的 current_version_id",
  );
  assert.ok(works[0].current_version_id.length > 0);
});

test("首页目录 listWorks 是轻量列表，不含正文 content", async () => {
  const service = createDataService({ mode: "demo" });
  const works = await service.listWorks();
  assert.ok(works.length >= 1);
  assert.ok(
    works.every((work) => !("content" in work)),
    "listWorks 不应携带正文 content",
  );
});

test("作者首次可改笔名且七天内只能继续修改简介", async () => {
  let now = new Date("2026-08-01T10:00:00+08:00").getTime();
  const service = createDataService({ mode: "demo", now: () => now });
  const session = await service.signIn({
    studentNumber: "2023123456",
    password: "wenyuan88",
  });
  const profile = await service.updateProfile(session.profile.id, {
    bio: "在夜里写作。",
    penName: "听松",
  });
  assert.equal(profile.pen_name, "听松");
  assert.equal(profile.bio, "在夜里写作。");
  assert.equal(profile.pen_name_changed_at, "2026-08-01T02:00:00.000Z");
  assert.equal(profile.role, "member");

  await assert.rejects(
    () =>
      service.updateProfile(session.profile.id, {
        bio: "新的简介。",
        penName: "再听松",
      }),
    /每七天只能修改一次/,
  );
  const bioOnly = await service.updateProfile(session.profile.id, {
    bio: "新的简介。",
    penName: "听松",
  });
  assert.equal(bioOnly.pen_name, "听松");
  assert.equal(bioOnly.bio, "新的简介。");

  now += PEN_NAME_CHANGE_INTERVAL_MS;
  const changedAgain = await service.updateProfile(session.profile.id, {
    bio: "新的简介。",
    penName: "松间",
  });
  assert.equal(changedAgain.pen_name, "松间");
  assert.equal(
    (await service.listWorks()).find((work) => work.author_id === session.profile.id)
      .author_pen_name,
    "松间",
  );
});

test("演示服务拒绝发布分类集合之外的作品分类", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({
    studentNumber: "2023123456",
    password: "wenyuan88",
  });

  await assert.rejects(
    () =>
      service.createWork({
        title: "错误分类",
        excerpt: "摘要",
        content: "正文",
        category: "诗歌",
      }),
    /分类.*新诗、旧诗、散文、小说、随笔、其他/,
  );
  await assert.rejects(
    () =>
      service.createWork({
        title: "任意分类",
        excerpt: "摘要",
        content: "正文",
        category: "影评",
      }),
    /分类.*新诗、旧诗、散文、小说、随笔、其他/,
  );
});

test("未登录用户不能执行写操作", async () => {
  const service = createDataService({ mode: "demo" });
  await assert.rejects(
    () =>
      service.createWork({
        title: "无名",
        excerpt: "摘要",
        content: "正文",
        category: "其他",
      }),
    /请先登录/,
  );
  await assert.rejects(() => service.toggleLike("work-river"), /请先登录/);
  await assert.rejects(
    () => service.addComment("work-river", "你好"),
    /请先登录/,
  );
});

test("新账号未验证邮箱时可登录阅读但不能写入", async () => {
  const service = createDataService({ mode: "demo" });
  const session = await service.signUp({
    studentNumber: "2024555555",
    password: "newmember88",
    penName: "远岫",
    recoveryEmail: "reader@example.com",
    captchaToken: "test-token",
  });
  assert.equal(session.accountSecurity.state, "pending");
  assert.equal("accountSecurity" in session.profile, false);
  assert.ok((await service.listWorks()).length > 0);
  assert.equal(service.canWrite(), false);
  await assert.rejects(() => service.createWork({
    title: "未验证",
    excerpt: "",
    content: "正文",
    category: "新诗",
  }), /验证找回邮箱/);
  await assert.rejects(() => service.setFeatured("work-river", true), /验证找回邮箱/);
  await service.verifyRecoveryEmail("123456");
  assert.equal(service.canWrite(), true);
  const work = await service.createWork({
    title: "已验证",
    excerpt: "",
    content: "正文",
    category: "新诗",
  });
  assert.equal(work.title, "已验证");
});

test("密码找回对存在与不存在账号返回相同文案", async () => {
  const service = createDataService({ mode: "demo" });
  const known = await service.requestPasswordRecovery("2023123456", "test-token");
  const missing = await service.requestPasswordRecovery("2099999999", "test-token");
  assert.equal(known.message, missing.message);
  assert.equal(known.message, "如果账号存在且已绑定邮箱，我们已发送验证码。");
});

test("密码找回完成后可用新密码登录并拒绝错误验证码", async () => {
  const service = createDataService({ mode: "demo" });
  await assert.rejects(
    () => service.completePasswordRecovery("2023123456", "000000", "newpass88", "test-token"),
    /验证码不正确/,
  );
  await assert.rejects(
    () => service.completePasswordRecovery("2023123456", "123456", "weak", "test-token"),
    /密码至少八位/,
  );
  const result = await service.completePasswordRecovery(
    "2023123456",
    "123456",
    "newpass88",
    "test-token",
  );
  assert.equal(result.message, "密码已更新，请使用新密码登录。");
  await service.signOut();
  const session = await service.signIn({
    studentNumber: "2023123456",
    password: "newpass88",
  });
  assert.equal(session.profile.pen_name, "松声");
});

test("演示账号可申请绑定找回邮箱并通过固定验证码验证", async () => {
  const service = createDataService({ mode: "demo" });
  const session = await service.signUp({
    studentNumber: "2024666666",
    password: "newmember88",
    penName: "远帆",
  });
  assert.equal(session.accountSecurity.state, "unbound");
  assert.equal(service.canWrite(), false);
  await service.requestRecoveryEmail("sailor@example.com", "test-token");
  assert.equal((await service.getAccountSecurityStatus()).state, "pending");
  assert.equal(
    (await service.getAccountSecurityStatus()).maskedEmail,
    "s***r@e***e.com",
  );
  await assert.rejects(() => service.verifyRecoveryEmail("000000"), /验证码不正确/);
  await service.verifyRecoveryEmail("123456");
  assert.equal(service.canWrite(), true);
});

test("演示账号完成找回邮箱变更并更新遮罩邮箱", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const before = await service.getAccountSecurityStatus();
  assert.equal(before.state, "verified");
  await service.requestRecoveryEmailChange("newreader@example.com", "test-token");
  assert.equal((await service.getAccountSecurityStatus()).state, "changing");
  await assert.rejects(
    () => service.confirmRecoveryEmailChangeNew("123456"),
    /先确认原邮箱|发起邮箱变更/,
  );
  await service.confirmRecoveryEmailChangeOld("123456");
  await service.confirmRecoveryEmailChangeNew("123456");
  const after = await service.getAccountSecurityStatus();
  assert.equal(after.state, "verified");
  assert.equal(after.maskedEmail, "n***r@e***e.com");
});

test("演示重认证校验当前密码并拒绝错误密码", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  assert.equal(await service.reauthenticate("wenyuan88"), true);
  await assert.rejects(() => service.reauthenticate("wrong88"), /当前密码不正确/);
});

test("已有演示账号默认为已验证状态且会话包含独立账号安全", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const session = await service.getSession();
  assert.equal(session.accountSecurity.state, "verified");
  assert.equal(service.canWrite(), true);
  assert.deepEqual(Object.keys(session).sort(), [
    "accountSecurity",
    "profile",
    "user",
  ]);
  assert.equal("accountSecurity" in session.profile, false);
});

test("Supabase 服务缓存账号安全状态并按函数名转发动作", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: {
              id: "user-1",
              email: "2023123456@accounts.wenyuan.invalid",
            },
          },
        },
        error: null,
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "user-1",
              pen_name: "松声",
              bio: "",
              role: "member",
            },
            error: null,
          }),
        }),
      }),
    }),
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
        if (name === "password-recovery" && body.action === "request") {
          return {
            data: { ok: true, message: "如果账号存在且已绑定邮箱，我们已发送验证码。" },
            error: null,
          };
        }
        return { data: {}, error: null };
      },
    },
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  const session = await service.getSession();
  assert.equal(session.profile.pen_name, "松声");
  assert.equal(session.accountSecurity.state, "verified");
  assert.equal(session.accountSecurity.maskedEmail, "s***g@e***e.com");
  assert.equal("accountSecurity" in session.profile, false);
  assert.equal(service.canWrite(), true);
  assert.deepEqual(invoked.at(-1), ["account-email", { action: "status" }]);

  const recovery = await service.requestPasswordRecovery("2023123456", "t");
  assert.equal(
    recovery.message,
    "如果账号存在且已绑定邮箱，我们已发送验证码。",
  );
  assert.deepEqual(invoked.at(-1), [
    "password-recovery",
    { action: "request", studentNumber: "2023123456", captchaToken: "t" },
  ]);

  await service.completePasswordRecovery(
    "2023123456",
    "123456",
    "newpass88",
    "t",
  );
  assert.deepEqual(invoked.at(-1), [
    "password-recovery",
    {
      action: "complete",
      studentNumber: "2023123456",
      code: "123456",
      newPassword: "newpass88",
      captchaToken: "t",
    },
  ]);
});

test("Supabase 服务按动作转发邮箱变更请求与确认", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: {
              id: "user-1",
              email: "2023123456@accounts.wenyuan.invalid",
            },
          },
        },
        error: null,
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "user-1",
              pen_name: "松声",
              bio: "",
              role: "member",
            },
            error: null,
          }),
        }),
      }),
    }),
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
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  await service.getSession();

  await service.requestRecoveryEmailChange("new@example.com", "t");
  assert.deepEqual(invoked.at(-1), [
    "account-email",
    { action: "request-change", newEmail: "new@example.com", captchaToken: "t" },
  ]);

  await service.confirmRecoveryEmailChangeOld("123456");
  assert.deepEqual(invoked.at(-1), [
    "account-email",
    { action: "confirm-change-old", code: "123456" },
  ]);

  await service.confirmRecoveryEmailChangeNew("654321");
  assert.deepEqual(invoked.at(-1), [
    "account-email",
    { action: "confirm-change-new", code: "654321" },
  ]);
});

test("Supabase 注册绑定失败返回 deliveryWarning 且重认证复用会话邮箱", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      signUp: async () => {
        const user = {
          id: "user-1",
          email: "2024777777@accounts.wenyuan.invalid",
        };
        return { data: { user, session: { user } }, error: null };
      },
      signInWithPassword: async ({ email, password }) => {
        invoked.push(["sign-in", email, password]);
        return { data: { user: { id: "user-1", email } }, error: null };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "user-1",
              pen_name: "远岫",
              bio: "",
              role: "member",
            },
            error: null,
          }),
        }),
      }),
    }),
    functions: {
      invoke: async (name, { body }) => {
        invoked.push([name, body]);
        if (name === "account-email" && body.action === "status") {
          return {
            data: { state: "unbound", maskedEmail: null, nextSendAt: null },
            error: null,
          };
        }
        if (name === "account-email" && body.action === "request-bind") {
          return { data: null, error: { message: "验证码邮件发送失败" } };
        }
        return { data: {}, error: null };
      },
    },
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  const session = await service.signUp({
    studentNumber: "2024777777",
    password: "newmember88",
    penName: "远岫",
    recoveryEmail: "reader@example.com",
    captchaToken: "t",
  });
  assert.equal(session.accountSecurity.state, "unbound");
  assert.equal(
    session.deliveryWarning,
    "验证码邮件暂时无法送达，稍后可在账号安全中重新发送",
  );
  assert.deepEqual(invoked.at(-1), [
    "account-email",
    { action: "request-bind", email: "reader@example.com", captchaToken: "t" },
  ]);

  const authenticated = await service.reauthenticate("newmember88");
  assert.equal(authenticated, true);
  assert.deepEqual(invoked.find(([name]) => name === "sign-in"), [
    "sign-in",
    "2024777777@accounts.wenyuan.invalid",
    "newmember88",
  ]);
});

test("演示服务按页返回作品、支持正文搜索与稳定游标", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  for (let i = 1; i <= 11; i += 1) {
    await service.createWork({
      title: `分页作品${i}`,
      excerpt: `摘要${i}`,
      content: `正文第${i}段，包含专属诗句 山雨欲来。`,
      category: "新诗",
    });
  }
  const page1 = await service.listWorksPage({
    query: "",
    category: "全部",
    sort: "latest",
    pageSize: 10,
  });
  assert.equal(page1.works.length, 10);
  assert.ok(page1.nextCursor, "第一页应有游标");
  assert.ok(
    page1.works.every((work) => "content" in work),
    "分页列表每页返回正文 content（移动端诗句卡片依赖）",
  );
  const page2 = await service.listWorksPage({
    query: "",
    category: "全部",
    sort: "latest",
    cursor: page1.nextCursor,
    pageSize: 10,
  });
  assert.equal(page2.works.length, 10);
  assert.ok(page2.nextCursor, "第二页应仍有游标");
  const page3 = await service.listWorksPage({
    query: "",
    category: "全部",
    sort: "latest",
    cursor: page2.nextCursor,
    pageSize: 10,
  });
  assert.equal(page3.works.length, 3);
  assert.equal(page3.nextCursor, null);
  const ids = [...page1.works, ...page2.works, ...page3.works].map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length, "各页作品不应重叠");

  const searched = await service.listWorksPage({
    query: "山雨欲来",
    category: "全部",
    sort: "latest",
    pageSize: 10,
  });
  const searchedRest = await service.listWorksPage({
    query: "山雨欲来",
    category: "全部",
    sort: "latest",
    cursor: searched.nextCursor,
    pageSize: 10,
  });
  const searchedAll = [...searched.works, ...searchedRest.works];
  assert.ok(searchedAll.length === 11, "正文搜索应命中全部 11 篇新增作品");
  assert.ok(searchedAll.every((w) => w.title.startsWith("分页作品")));

  const cat = await service.listWorksPage({
    query: "",
    category: "散文",
    sort: "latest",
    pageSize: 10,
  });
  assert.ok(cat.works.length >= 1);
  assert.ok(cat.works.every((w) => w.category === "散文"));
});

test("演示服务独立分页讨论", async () => {
  const service = createDataService({ mode: "demo" });
  const page = await service.listDiscussionsPage({ pageSize: 20 });
  assert.ok(page.discussions.length >= 1);
  assert.equal(typeof page.discussions[0].work_title, "string");
  assert.equal(typeof page.discussions[0].user_pen_name, "string");
});

test("演示讨论页只展示已发布作品的评论", async () => {
  const seed = structuredClone(demoSeed);
  const hiddenWork = seed.works.find((work) => work.id === "work-night-bus");
  assert.ok(hiddenWork, "种子数据应有 work-night-bus");
  hiddenWork.status = "draft";
  const service = createDataService({ mode: "demo", seed });
  const page = await service.listDiscussionsPage({ pageSize: 20 });
  assert.ok(
    page.discussions.every((discussion) => discussion.work_id !== hiddenWork.id),
    "未发布作品的评论不应出现在讨论页",
  );
});

test("Supabase 服务通过 RPC 分页浏览作品与讨论", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: null,
      }),
    },
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name === "browse_works") {
        return {
          data: {
            works: [
              {
                id: "work-1",
                title: "返回作品",
                like_count: 3,
                comment_count: 1,
                liked_by_current_user: false,
              },
            ],
            next_cursor: "cursor-1",
          },
          error: null,
        };
      }
      if (name === "browse_discussions") {
        return {
          data: {
            discussions: [
              {
                id: "disc-1",
                work_title: "返回作品",
                user_pen_name: "松声",
                content: "评论",
              },
            ],
            next_cursor: null,
          },
          error: null,
        };
      }
      return { data: null, error: { message: "unknown" } };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  const worksPage = await service.listWorksPage({
    query: "山雨",
    category: "新诗",
    sort: "likes",
    cursor: "prev-cursor",
    pageSize: 10,
  });
  assert.equal(worksPage.works[0].title, "返回作品");
  assert.equal(worksPage.nextCursor, "cursor-1");
  assert.deepEqual(invoked.at(-1), [
    "browse_works",
    {
      p_search: "山雨",
      p_category: "新诗",
      p_sort: "likes",
      p_cursor: "prev-cursor",
      p_page_size: 10,
    },
  ]);

  const discussionsPage = await service.listDiscussionsPage({
    cursor: "disc-cursor",
    pageSize: 20,
  });
  assert.equal(discussionsPage.discussions[0].work_title, "返回作品");
  assert.equal(discussionsPage.nextCursor, null);
  assert.deepEqual(invoked.at(-1), [
    "browse_discussions",
    { p_cursor: "disc-cursor", p_page_size: 20 },
  ]);
});

test("Supabase 首页目录 listWorks 不请求 content 正文", async () => {
  let selectArg = null;
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: null,
      }),
    },
    from: () => ({
      select: (columns) => {
        selectArg = columns;
        return {
          eq: () => ({
            order: async () => ({ data: [], error: null }),
          }),
        };
      },
    }),
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  await service.listWorks();
  assert.ok(
    selectArg.includes("id,author_id,title"),
    "listWorks 应显式选择目录列",
  );
  assert.ok(
    !selectArg.includes("content"),
    "listWorks 不应请求 content 正文",
  );
});

test("演示服务记录版本历史、编辑生成新版本且恢复不丢历史", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "初稿",
    excerpt: "",
    category: "散文",
    content: "第一段。\n\n第二段。",
  });
  assert.equal(created.current_version_number, 1);

  const versions1 = await service.listWorkVersions(created.id);
  assert.equal(versions1.length, 1);
  assert.equal(versions1[0].version_number, 1);
  assert.equal(versions1[0].change_summary, "初次发布");

  const edited = await service.createWorkVersion({
    workId: created.id,
    expectedVersionNumber: 1,
    title: "初稿·修订",
    excerpt: "",
    category: "散文",
    content: "第一段。\n\n第二段。\n\n第三段。",
    changeSummary: "补第三段",
  });
  assert.equal(edited.current_version_number, 2);

  const versions2 = await service.listWorkVersions(created.id);
  assert.equal(versions2.length, 2);
  assert.equal(versions2[0].version_number, 2);
  assert.doesNotMatch(versions2[1].content, /第三段/, "第 1 版不被覆盖");

  const restored = await service.restoreWorkVersion({
    workId: created.id,
    sourceVersionId: versions2[1].id,
    expectedVersionNumber: 2,
    changeSummary: "回到初稿",
  });
  assert.equal(restored.current_version_number, 3);
  const versions3 = await service.listWorkVersions(created.id);
  assert.equal(versions3.length, 3);
  assert.equal(versions3[0].restored_from_version_id, versions2[1].id);
});

test("演示服务版本冲突、非作者与缺失修改说明被拒绝", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "冲突测试",
    excerpt: "",
    category: "散文",
    content: "正文",
  });
  await assert.rejects(
    service.createWorkVersion({
      workId: created.id,
      expectedVersionNumber: 99,
      title: "x",
      excerpt: "",
      category: "散文",
      content: "y",
      changeSummary: "说明",
    }),
    /已被他人修改/,
  );
  await assert.rejects(
    service.createWorkVersion({
      workId: created.id,
      expectedVersionNumber: 1,
      title: "x",
      excerpt: "",
      category: "散文",
      content: "y",
      changeSummary: "",
    }),
    /修改说明/,
  );
});

test("演示服务恢复路径校验修改说明且非作者被拒", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "恢复路径测试",
    excerpt: "",
    category: "散文",
    content: "正文",
  });
  const versions = await service.listWorkVersions(created.id);
  const sourceVersionId = versions[0].id;
  // 恢复路径：缺失修改说明
  await assert.rejects(
    service.restoreWorkVersion({
      workId: created.id,
      sourceVersionId,
      expectedVersionNumber: 1,
      changeSummary: "",
    }),
    /修改说明/,
  );
  // 恢复路径：修改说明超过 200 个字符
  await assert.rejects(
    service.restoreWorkVersion({
      workId: created.id,
      sourceVersionId,
      expectedVersionNumber: 1,
      changeSummary: "改".repeat(201),
    }),
    /不能超过 200 个字符/,
  );
  // 非作者（白露）不能编辑或恢复他人作品
  await service.signIn({ studentNumber: "2022111111", password: "reader88" });
  await assert.rejects(
    service.createWorkVersion({
      workId: created.id,
      expectedVersionNumber: 1,
      title: "x",
      excerpt: "",
      category: "散文",
      content: "y",
      changeSummary: "说明",
    }),
    /只有作者/,
  );
  await assert.rejects(
    service.restoreWorkVersion({
      workId: created.id,
      sourceVersionId,
      expectedVersionNumber: 1,
      changeSummary: "说明",
    }),
    /只有作者/,
  );
});

test("演示服务批注：保存正确版本原文位置，位置不符被拒", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "批注测试",
    excerpt: "",
    category: "散文",
    content: "第一段。\n\n第二段。",
  });
  const versions = await service.listWorkVersions(created.id);
  const v1 = versions[0];
  // 展示串 = "第一段。\n第二段。"，"第二段。"位于 [5,9)
  const result = await service.createQuotedComment({
    workId: created.id,
    workVersionId: v1.id,
    quoteText: "第二段。",
    startOffset: 5,
    endOffset: 9,
    content: "这句写得准。",
  });
  assert.equal(result.quote.work_version_id, v1.id);
  assert.equal(result.comment.content, "这句写得准。");
  const quotes = await service.listWorkQuotes(created.id);
  assert.equal(quotes[0].quote_text, "第二段。");
  await assert.rejects(
    service.createQuotedComment({
      workId: created.id,
      workVersionId: v1.id,
      quoteText: "伪造原文",
      startOffset: 0,
      endOffset: 4,
      content: "内容",
    }),
    /不符/,
  );
});

test("演示服务批注：emoji 正文按码点偏移对齐（与 SQL char_length/substr 一致）", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "emoji 批注测试",
    excerpt: "",
    category: "散文",
    content: "第一段😀。\n\n第二段。",
  });
  const versions = await service.listWorkVersions(created.id);
  const v1 = versions[0];
  // 展示串 = "第一段😀。\n第二段。"，"第二段。"位于码点 [6,10)
  const result = await service.createQuotedComment({
    workId: created.id,
    workVersionId: v1.id,
    quoteText: "第二段。",
    startOffset: 6,
    endOffset: 10,
    content: "emoji 之前没问题。",
  });
  assert.equal(result.quote.quote_text, "第二段。");
  const quotes = await service.listWorkQuotes(created.id);
  assert.equal(quotes[0].start_offset, 6);
  assert.equal(quotes[0].end_offset, 10);
});

test("演示服务批注：段首 NBSP 不被 trim（展示串与 SQL btrim 一致）", async () => {
  const service = createDataService({ mode: "demo" });
  await service.signIn({ studentNumber: "2023123456", password: "wenyuan88" });
  const created = await service.createWork({
    title: "NBSP 批注测试",
    excerpt: "",
    category: "散文",
    content: " 第一段。\n\n第二段。",
  });
  const versions = await service.listWorkVersions(created.id);
  const v1 = versions[0];
  // 展示串 = " 第一段。\n第二段。"，"第二段。"位于码点 [6,10)
  const result = await service.createQuotedComment({
    workId: created.id,
    workVersionId: v1.id,
    quoteText: "第二段。",
    startOffset: 6,
    endOffset: 10,
    content: "段首 NBSP 不影响后续批注。",
  });
  assert.equal(result.quote.quote_text, "第二段。");
});

test("Supabase 服务通过 RPC 创建版本、恢复版本并返回版本/批注", async () => {
  const invoked = [];
  // 模拟服务端作品行随 RPC 写入推进的当前版本号（create→2、restore→3）
  let workVersionNumber = 1;
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { id: "u-1", email: "a@x.test" },
            access_token: "t",
          },
        },
        error: null,
      }),
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            table === "works"
              ? {
                  data: {
                    id: "work-1",
                    author_id: "u-1",
                    title: "修订",
                    excerpt: "",
                    content: "正文",
                    category: "散文",
                    status: "published",
                    is_featured: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    current_version_id: `v-${workVersionNumber}`,
                    work_versions: { version_number: workVersionNumber },
                    profiles: { pen_name: "松声", bio: "", role: "member" },
                  },
                  error: null,
                }
              : { data: null, error: null },
        }),
        in: async () => ({ data: [], error: null }),
      }),
    }),
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name === "create_work_version") {
        workVersionNumber = 2;
        return {
          data: {
            work_id: "work-1",
            version_id: "v-2",
            version_number: 2,
            change_summary: "补第三段",
            is_new: false,
          },
          error: null,
        };
      }
      if (name === "restore_work_version") {
        workVersionNumber = 3;
        return {
          data: {
            work_id: "work-1",
            version_id: "v-3",
            version_number: 3,
            restored_from_version_id: "v-1",
            change_summary: "回到初稿",
          },
          error: null,
        };
      }
      if (name === "list_work_versions") {
        return {
          data: [
            { id: "v-2", version_number: 2, title: "修订", excerpt: "", content: "正文", category: "散文", change_summary: "补第三段", restored_from_version_id: null, created_by: "u-1", created_at: new Date().toISOString() },
            { id: "v-1", version_number: 1, title: "初稿", excerpt: "", content: "正文", category: "散文", change_summary: "初次发布", restored_from_version_id: null, created_by: "u-1", created_at: new Date().toISOString() },
          ],
          error: null,
        };
      }
      if (name === "create_quoted_comment") {
        return {
          data: {
            comment: { id: "c-1", work_id: "work-1", user_id: "u-2", content: "这句写得准。", is_deleted: false, created_at: new Date().toISOString() },
            quote: { id: "q-1", work_version_id: "v-1", quote_text: "第二段。", start_offset: 7, end_offset: 11 },
          },
          error: null,
        };
      }
      if (name === "list_work_quotes") {
        return {
          data: [{ comment_id: "c-1", work_version_id: "v-1", quote_text: "第二段。", start_offset: 7, end_offset: 11, comment_content: "这句写得准。", is_deleted: false, user_id: "u-2", user_pen_name: "白露", created_at: new Date().toISOString() }],
          error: null,
        };
      }
      return { data: null, error: { message: "unknown" } };
    },
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });

  const edited = await service.createWorkVersion({
    workId: "work-1",
    expectedVersionNumber: 1,
    title: "修订",
    excerpt: "",
    category: "散文",
    content: "正文",
    changeSummary: "补第三段",
  });
  assert.equal(edited.current_version_number, 2);
  assert.deepEqual(invoked.at(-1), [
    "create_work_version",
    { p_work_id: "work-1", p_expected_version_number: 1, p_title: "修订", p_excerpt: "", p_category: "散文", p_content: "正文", p_change_summary: "补第三段" },
  ]);

  const restored = await service.restoreWorkVersion({
    workId: "work-1",
    sourceVersionId: "v-1",
    expectedVersionNumber: 2,
    changeSummary: "回到初稿",
  });
  assert.equal(restored.current_version_number, 3);
  assert.deepEqual(invoked.at(-1), [
    "restore_work_version",
    { p_work_id: "work-1", p_source_version_id: "v-1", p_expected_version_number: 2, p_change_summary: "回到初稿" },
  ]);

  const versions = await service.listWorkVersions("work-1");
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version_number, 2);

  const quoted = await service.createQuotedComment({
    workId: "work-1",
    workVersionId: "v-1",
    quoteText: "第二段。",
    startOffset: 7,
    endOffset: 11,
    content: "这句写得准。",
  });
  assert.equal(quoted.quote.work_version_id, "v-1");
  assert.deepEqual(invoked.at(-1), [
    "create_quoted_comment",
    { p_work_id: "work-1", p_work_version_id: "v-1", p_quote_text: "第二段。", p_start_offset: 7, p_end_offset: 11, p_content: "这句写得准。" },
  ]);

  const quotes = await service.listWorkQuotes("work-1");
  assert.equal(quotes[0].quote_text, "第二段。");
});

test("Supabase createWork 走 create_work_version RPC（新作品）", async () => {
  const invoked = [];
  const fakeClient = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { id: "u-1", email: "a@x.test" },
            access_token: "t",
          },
        },
        error: null,
      }),
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            table === "works"
              ? {
                  data: {
                    id: "work-new",
                    author_id: "u-1",
                    title: "新作",
                    excerpt: "",
                    content: "正文",
                    category: "散文",
                    status: "published",
                    is_featured: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    current_version_id: "v-1",
                    work_versions: { version_number: 1 },
                    profiles: { pen_name: "松声", bio: "", role: "member" },
                  },
                  error: null,
                }
              : { data: null, error: null },
        }),
        in: async () => ({ data: [], error: null }),
      }),
    }),
    rpc: async (name, args) => {
      invoked.push([name, args]);
      if (name === "create_work_version") {
        return {
          data: { work_id: "work-new", version_id: "v-1", version_number: 1, change_summary: "初次发布", is_new: true },
          error: null,
        };
      }
      if (name === "delete_work") {
        return { data: null, error: null };
      }
      return { data: null, error: { message: "unknown" } };
    },
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  const work = await service.createWork({
    title: "新作",
    excerpt: "",
    category: "散文",
    content: "正文",
  });
  assert.equal(work.current_version_number, 1);
  assert.deepEqual(invoked.at(-1), [
    "create_work_version",
    { p_work_id: null, p_expected_version_number: null, p_title: "新作", p_excerpt: "正文", p_category: "散文", p_content: "正文", p_change_summary: "" },
  ]);

  await service.deleteWork(work.id);
  assert.deepEqual(invoked.at(-1), ["delete_work", { p_work_id: "work-new" }]);
});

test("Supabase getWork 返回 current_version_number 与作者与评论", async () => {
  const workRow = {
    id: "work-1",
    author_id: "u-1",
    title: "修订",
    excerpt: "",
    content: "正文",
    category: "散文",
    status: "published",
    is_featured: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    current_version_id: "v-2",
    work_versions: { version_number: 2 },
    profiles: { id: "u-1", pen_name: "松声", bio: "", role: "member", created_at: new Date().toISOString() },
  };
  const fakeClient = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    },
    from: (table) => ({
      select: () => {
        const chain = {
          eq: () => chain,
          in: async () => ({ data: [], error: null }),
          order: async () => ({ data: [], error: null }),
          single: async () =>
            table === "works"
              ? { data: workRow, error: null }
              : { data: null, error: null },
        };
        return chain;
      },
    }),
  };
  const service = createDataService({
    mode: "supabase",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
    clientOverride: fakeClient,
  });
  const work = await service.getWork("work-1");
  assert.equal(work.current_version_number, 2);
  assert.equal(work.author_pen_name, "松声");
  assert.deepEqual(work.comments, []);
});
