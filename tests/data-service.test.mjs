import test from "node:test";
import assert from "node:assert/strict";
import { createDataService } from "../js/data-service.mjs";
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
