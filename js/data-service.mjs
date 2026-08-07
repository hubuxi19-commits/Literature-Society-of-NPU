import { demoSeed } from "./demo-data.mjs";
import {
  createExcerpt,
  getPenNameChangeAvailability,
  maskEmail,
  PUBLISHABLE_CATEGORIES,
  searchWorks,
  studentNumberToAuthEmail,
  validatePassword,
  validateStudentNumber,
} from "./utils.mjs";

const SUPABASE_MODULE_URL =
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const DEMO_SECURITY_CODE = "123456";
const FIXED_RECOVERY_REQUEST_MESSAGE =
  "如果账号存在且已绑定邮箱，我们已发送验证码。";
const PASSWORD_UPDATED_MESSAGE = "密码已更新，请使用新密码登录。";

function clone(value) {
  return structuredClone(value);
}

function makeId(prefix) {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function requireText(value, label, maximum) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (Array.from(text).length > maximum) {
    throw new Error(`${label}不能超过 ${maximum} 字`);
  }
  return text;
}

function requirePublishableCategory(value) {
  const category = requireText(value, "分类", 12);
  if (!PUBLISHABLE_CATEGORIES.includes(category)) {
    throw new Error(`分类只能是${PUBLISHABLE_CATEGORIES.join("、")}`);
  }
  return category;
}

function createDemoService(config = {}) {
  const state = clone(demoSeed);
  state.profiles.forEach((profile) => {
    profile.pen_name_changed_at ??= null;
  });
  let session = null;
  const now = () =>
    new Date(typeof config.now === "function" ? config.now() : Date.now());

  const getProfileRecord = (profileId) =>
    state.profiles.find((profile) => profile.id === profileId);

  const requireSession = () => {
    if (!session) throw new Error("请先登录");
    return session;
  };

  const isAdmin = () => session?.profile?.role === "admin";

  const getSecurityView = (profileId) => {
    const security = state.accountSecurityByUserId[profileId];
    if (!security) {
      return { state: "unbound", maskedEmail: null, nextSendAt: null };
    }
    return {
      state: security.state,
      maskedEmail: security.emailNormalized
        ? maskEmail(security.emailNormalized)
        : null,
      nextSendAt: security.nextSendAt ?? null,
    };
  };

  const requireVerifiedSession = () => {
    const current = requireSession();
    const security = state.accountSecurityByUserId[current.profile.id];
    if (
      !security ||
      (security.state !== "verified" && security.state !== "changing")
    ) {
      throw new Error("请先验证找回邮箱");
    }
    return current;
  };

  const makeSession = (profile) => ({
    user: { id: profile.id },
    profile: clone(profile),
    accountSecurity: getSecurityView(profile.id),
  });

  const normalizeRecoveryEmailInput = (value) => {
    const normalized = String(value ?? "").trim().toLowerCase();
    const atIndex = normalized.indexOf("@");
    if (
      atIndex <= 0 ||
      atIndex !== normalized.lastIndexOf("@") ||
      normalized.slice(atIndex + 1).length < 3
    ) {
      throw new Error("找回邮箱格式不正确");
    }
    return normalized;
  };

  const beginBinding = (profileId, email, captchaToken) => {
    if (!String(captchaToken ?? "").trim()) throw new Error("请完成人机验证");
    const emailNormalized = normalizeRecoveryEmailInput(email);
    state.accountSecurityByUserId[profileId] = {
      state: "pending",
      emailNormalized,
      nextSendAt: new Date(now().getTime() + 60_000).toISOString(),
    };
  };

  const enrichComment = (comment) => {
    const profile = getProfileRecord(comment.user_id);
    return {
      ...clone(comment),
      user_pen_name: profile?.pen_name ?? "佚名",
      user_role: profile?.role ?? "member",
    };
  };

  const enrichWork = (work) => {
    const profile = getProfileRecord(work.author_id);
    const workLikes = state.likes.filter((like) => like.work_id === work.id);
    const workComments = state.comments.filter(
      (comment) => comment.work_id === work.id,
    );
    return {
      ...clone(work),
      author_pen_name: profile?.pen_name ?? "佚名",
      author_bio: profile?.bio ?? "",
      author_role: profile?.role ?? "member",
      like_count: workLikes.length,
      comment_count: workComments.length,
      liked_by_current_user: Boolean(
        session &&
          workLikes.some((like) => like.user_id === session.profile.id),
      ),
    };
  };

  const encodeCursor = (index) =>
    Buffer.from(JSON.stringify({ start: index })).toString("base64");

  const listWorksPageDemo = async (options = {}) => {
    const pageSize = Math.min(
      Math.max(Number(options.pageSize) || 10, 1),
      10,
    );
    const start = (() => {
      if (!options.cursor) return 0;
      try {
        return Number(
          JSON.parse(Buffer.from(String(options.cursor), "base64").toString("utf8"))
            .start || 0,
        );
      } catch {
        return 0;
      }
    })();
    const enriched = state.works
      .filter((work) => work.status === "published")
      .map(enrichWork);
    const sorted = searchWorks(enriched, {
      query: options.query,
      category: options.category,
      sort: options.sort,
    });
    const page = sorted.slice(start, start + pageSize);
    const nextStart = start + page.length;
    return {
      works: page,
      nextCursor:
        nextStart < sorted.length ? encodeCursor(nextStart) : null,
    };
  };

  const listDiscussionsPageDemo = async (options = {}) => {
    const pageSize = Math.min(
      Math.max(Number(options.pageSize) || 20, 1),
      20,
    );
    const start = (() => {
      if (!options.cursor) return 0;
      try {
        return Number(
          JSON.parse(Buffer.from(String(options.cursor), "base64").toString("utf8"))
            .start || 0,
        );
      } catch {
        return 0;
      }
    })();
    const rows = state.comments
      .map((comment) => {
        const work = state.works.find((item) => item.id === comment.work_id);
        return {
          ...enrichComment(comment),
          work_title: work?.title ?? "已删除作品",
          work_id: comment.work_id,
        };
      })
      .sort(
        (left, right) =>
          new Date(right.created_at) - new Date(left.created_at) ||
          String(left.id ?? "").localeCompare(String(right.id ?? "")),
      );
    const page = rows.slice(start, start + pageSize);
    const nextStart = start + page.length;
    return {
      discussions: page,
      nextCursor:
        nextStart < rows.length ? encodeCursor(nextStart) : null,
    };
  };

  const service = {
    mode: "demo",
    isDemo: true,

    async getSession() {
      return session ? clone(session) : null;
    },

    async signIn({ studentNumber, password }) {
      const normalizedNumber = String(studentNumber ?? "").trim();
      const account = state.accounts.find(
        (item) =>
          item.studentNumber === normalizedNumber && item.password === password,
      );
      if (!account) throw new Error("学号或密码不正确");
      const profile = getProfileRecord(account.profileId);
      session = makeSession(profile);
      return clone(session);
    },

    async signUp({ studentNumber, password, penName, recoveryEmail, captchaToken }) {
      const normalizedNumber = String(studentNumber ?? "").trim();
      if (!validateStudentNumber(normalizedNumber)) {
        throw new Error("学号格式不正确");
      }
      if (!validatePassword(password)) {
        throw new Error("密码至少八位，且需要同时包含字母和数字");
      }
      if (
        state.accounts.some(
          (account) => account.studentNumber === normalizedNumber,
        )
      ) {
        throw new Error("该学号已经注册");
      }
      const createdAt = now().toISOString();
      const profile = {
        id: makeId("profile"),
        pen_name: requireText(penName, "笔名", 24),
        bio: "",
        role: "member",
        pen_name_changed_at: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      state.profiles.push(profile);
      state.accounts.push({
        studentNumber: normalizedNumber,
        password: String(password),
        profileId: profile.id,
      });
      session = makeSession(profile);
      if (recoveryEmail) {
        beginBinding(profile.id, recoveryEmail, captchaToken);
        session = makeSession(profile);
      }
      return clone(session);
    },

    async signOut() {
      session = null;
    },

    async listWorks() {
      return state.works
        .filter((work) => work.status === "published")
        .map(enrichWork)
        .sort(
          (left, right) =>
            new Date(right.created_at) - new Date(left.created_at),
        );
    },

    async listWorksPage(options = {}) {
      return listWorksPageDemo(options);
    },

    async listDiscussionsPage(options = {}) {
      return listDiscussionsPageDemo(options);
    },

    async getWork(workId) {
      const work = state.works.find(
        (item) => item.id === workId && item.status === "published",
      );
      if (!work) throw new Error("作品不存在");
      return {
        ...enrichWork(work),
        author_profile: clone(getProfileRecord(work.author_id)),
        comments: state.comments
          .filter((comment) => comment.work_id === work.id)
          .map(enrichComment)
          .sort(
            (left, right) =>
              new Date(left.created_at) - new Date(right.created_at),
          ),
      };
    },

    async createWork(input) {
      const current = requireVerifiedSession();
      const now = new Date().toISOString();
      const content = requireText(input.content, "正文", 50000);
      const work = {
        id: makeId("work"),
        author_id: current.profile.id,
        title: requireText(input.title, "标题", 80),
        excerpt:
          String(input.excerpt ?? "").trim() || createExcerpt(content, 96),
        content,
        category: requirePublishableCategory(input.category),
        status: "published",
        is_featured: false,
        created_at: now,
        updated_at: now,
      };
      state.works.push(work);
      return enrichWork(work);
    },

    async deleteWork(workId) {
      const current = requireVerifiedSession();
      const index = state.works.findIndex((work) => work.id === workId);
      if (index < 0) throw new Error("作品不存在");
      const work = state.works[index];
      if (work.author_id !== current.profile.id && !isAdmin()) {
        throw new Error("没有权限删除这篇作品");
      }
      state.works.splice(index, 1);
      state.likes = state.likes.filter((like) => like.work_id !== workId);
      state.comments = state.comments.filter(
        (comment) => comment.work_id !== workId,
      );
    },

    async toggleLike(workId) {
      const current = requireVerifiedSession();
      if (!state.works.some((work) => work.id === workId)) {
        throw new Error("作品不存在");
      }
      const index = state.likes.findIndex(
        (like) =>
          like.work_id === workId && like.user_id === current.profile.id,
      );
      let liked;
      if (index >= 0) {
        state.likes.splice(index, 1);
        liked = false;
      } else {
        state.likes.push({
          work_id: workId,
          user_id: current.profile.id,
        });
        liked = true;
      }
      return {
        liked,
        likeCount: state.likes.filter((like) => like.work_id === workId)
          .length,
      };
    },

    async addComment(workId, content, parentId = null) {
      const current = requireVerifiedSession();
      if (!state.works.some((work) => work.id === workId)) {
        throw new Error("作品不存在");
      }
      if (
        parentId &&
        !state.comments.some(
          (comment) => comment.id === parentId && comment.work_id === workId,
        )
      ) {
        throw new Error("回复的评论不存在");
      }
      const now = new Date().toISOString();
      const comment = {
        id: makeId("comment"),
        work_id: workId,
        user_id: current.profile.id,
        parent_id: parentId,
        content: requireText(content, "评论", 2000),
        is_deleted: false,
        created_at: now,
        updated_at: now,
      };
      state.comments.push(comment);
      return enrichComment(comment);
    },

    async deleteComment(commentId) {
      const current = requireVerifiedSession();
      const comment = state.comments.find((item) => item.id === commentId);
      if (!comment) throw new Error("评论不存在");
      if (comment.user_id !== current.profile.id && !isAdmin()) {
        throw new Error("没有权限删除这条评论");
      }
      comment.is_deleted = true;
      comment.content = "";
      comment.updated_at = new Date().toISOString();
      return enrichComment(comment);
    },

    async getProfile(profileId) {
      const profile = getProfileRecord(profileId);
      if (!profile) throw new Error("作者不存在");
      const works = state.works
        .filter(
          (work) =>
            work.author_id === profileId && work.status === "published",
        )
        .map(enrichWork);
      return {
        ...clone(profile),
        works,
        work_count: works.length,
        total_likes: works.reduce(
          (total, work) => total + work.like_count,
          0,
        ),
        comment_count: state.comments.filter(
          (comment) => comment.user_id === profileId,
        ).length,
      };
    },

    async updateProfile(profileId, input) {
      const current = requireVerifiedSession();
      if (current.profile.id !== profileId) {
        throw new Error("没有权限修改该资料");
      }
      const profile = getProfileRecord(profileId);
      if (!profile) throw new Error("作者不存在");
      const penName = requireText(input.penName ?? profile.pen_name, "笔名", 24);
      const changedAt = now();
      if (penName !== profile.pen_name) {
        const availability = getPenNameChangeAvailability(
          profile.pen_name_changed_at,
          changedAt,
        );
        if (!availability.canChange) {
          throw new Error("笔名每七天只能修改一次，请在冷却期结束后再试");
        }
        profile.pen_name = penName;
        profile.pen_name_changed_at = changedAt.toISOString();
      }
      profile.bio = String(input.bio ?? "").trim().slice(0, 240);
      profile.updated_at = changedAt.toISOString();
      if (current.profile.id === profileId) {
        session.profile = clone(profile);
      }
      return clone(profile);
    },

    async getSiteSettings() {
      return clone(state.siteSettings);
    },

    async setFeatured(workId, featured) {
      requireVerifiedSession();
      if (!isAdmin()) throw new Error("只有管理员可以设置编辑推荐");
      const work = state.works.find((item) => item.id === workId);
      if (!work) throw new Error("作品不存在");
      work.is_featured = Boolean(featured);
      work.updated_at = new Date().toISOString();
      return { id: work.id, is_featured: work.is_featured };
    },

    async getAccountSecurityStatus() {
      const current = requireSession();
      return getSecurityView(current.profile.id);
    },

    async requestRecoveryEmail(email, captchaToken) {
      const current = requireSession();
      const security = state.accountSecurityByUserId[current.profile.id];
      if (security?.state === "verified") throw new Error("该找回邮箱已经验证");
      beginBinding(current.profile.id, email, captchaToken);
      return { ok: true, message: FIXED_RECOVERY_REQUEST_MESSAGE };
    },

    async verifyRecoveryEmail(code) {
      const current = requireSession();
      const security = state.accountSecurityByUserId[current.profile.id];
      if (!security || security.state !== "pending") {
        throw new Error("请先申请验证码");
      }
      if (String(code ?? "").trim() !== DEMO_SECURITY_CODE) {
        throw new Error("验证码不正确");
      }
      security.state = "verified";
      security.nextSendAt = null;
      return { maskedEmail: maskEmail(security.emailNormalized) };
    },

    async reauthenticate(currentPassword) {
      const current = requireSession();
      const account = state.accounts.find(
        (item) => item.profileId === current.profile.id,
      );
      if (!account || account.password !== String(currentPassword)) {
        throw new Error("当前密码不正确");
      }
      return true;
    },

    async requestRecoveryEmailChange(newEmail, captchaToken) {
      const current = requireVerifiedSession();
      if (!String(captchaToken ?? "").trim()) throw new Error("请完成人机验证");
      const emailNormalized = normalizeRecoveryEmailInput(newEmail);
      const security = state.accountSecurityByUserId[current.profile.id];
      security.state = "changing";
      security.nextEmailNormalized = emailNormalized;
      security.nextSendAt = new Date(now().getTime() + 60_000).toISOString();
      return { ok: true, message: "验证码已发送到当前邮箱，请查收并确认。" };
    },

    async confirmRecoveryEmailChangeOld(code) {
      const current = requireVerifiedSession();
      const security = state.accountSecurityByUserId[current.profile.id];
      if (security.state !== "changing") throw new Error("请先发起邮箱变更");
      if (String(code ?? "").trim() !== DEMO_SECURITY_CODE) {
        throw new Error("验证码不正确");
      }
      security.oldConfirmed = true;
      security.nextSendAt = new Date(now().getTime() + 60_000).toISOString();
      return { ok: true, message: "验证成功，验证码已发送到新邮箱。" };
    },

    async confirmRecoveryEmailChangeNew(code) {
      const current = requireVerifiedSession();
      const security = state.accountSecurityByUserId[current.profile.id];
      if (security.state !== "changing") throw new Error("请先发起邮箱变更");
      if (!security.oldConfirmed) throw new Error("请先确认原邮箱");
      if (String(code ?? "").trim() !== DEMO_SECURITY_CODE) {
        throw new Error("验证码不正确");
      }
      security.state = "verified";
      security.emailNormalized = security.nextEmailNormalized;
      security.nextEmailNormalized = null;
      security.oldConfirmed = false;
      security.nextSendAt = null;
      return { maskedEmail: maskEmail(security.emailNormalized) };
    },

    async requestPasswordRecovery(studentNumber, captchaToken) {
      if (!validateStudentNumber(studentNumber)) {
        throw new Error("学号格式不正确");
      }
      if (!String(captchaToken ?? "").trim()) throw new Error("请完成人机验证");
      return { ok: true, message: FIXED_RECOVERY_REQUEST_MESSAGE };
    },

    async completePasswordRecovery(studentNumber, code, newPassword, captchaToken) {
      if (!validateStudentNumber(studentNumber)) {
        throw new Error("学号格式不正确");
      }
      if (!validatePassword(newPassword)) {
        throw new Error("密码至少八位，且需要同时包含字母和数字");
      }
      if (!String(captchaToken ?? "").trim()) throw new Error("请完成人机验证");
      if (String(code ?? "").trim() !== DEMO_SECURITY_CODE) {
        throw new Error("验证码不正确");
      }
      const account = state.accounts.find(
        (item) => item.studentNumber === String(studentNumber ?? "").trim(),
      );
      if (!account) throw new Error("验证码不正确");
      account.password = String(newPassword);
      return { ok: true, message: PASSWORD_UPDATED_MESSAGE };
    },

    canWrite() {
      if (!session) return false;
      const security = state.accountSecurityByUserId[session.profile.id];
      return Boolean(
        security &&
          (security.state === "verified" || security.state === "changing"),
      );
    },
  };

  return service;
}

function createSupabaseService(config) {
  let clientPromise;
  let cachedSession = null;

  const getClient = async () => {
    if (config.clientOverride) return config.clientOverride;
    if (!clientPromise) {
      clientPromise = import(SUPABASE_MODULE_URL).then(({ createClient }) =>
        createClient(config.supabaseUrl, config.supabasePublishableKey ?? config.supabaseAnonKey),
      );
    }
    return clientPromise;
  };

  const invokeFunction = async (name, body) => {
    const client = await getClient();
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) throw new Error(data?.message || error.message);
    return data;
  };

  const getCurrentProfile = async (client, userId) => {
    const { data, error } = await client
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  };

  const buildCachedSession = async (client, user) => {
    let accountSecurity = null;
    try {
      const status = await invokeFunction("account-email", {
        action: "status",
      });
      accountSecurity = {
        state: status?.state ?? "unbound",
        maskedEmail: status?.maskedEmail ?? null,
        nextSendAt: status?.nextSendAt ?? null,
      };
    } catch {
      accountSecurity = null;
    }
    return {
      user,
      profile: await getCurrentProfile(client, user.id),
      accountSecurity,
    };
  };

  const requireRemoteSession = async () => {
    const current = await service.getSession();
    if (!current) throw new Error("请先登录");
    return current;
  };

  const enrichRemoteWorks = async (client, works) => {
    const sessionValue = await service.getSession();
    const ids = works.map((work) => work.id);
    if (!ids.length) return [];
    const [{ data: likes, error: likeError }, { data: comments, error: commentError }] =
      await Promise.all([
        client.from("likes").select("work_id,user_id").in("work_id", ids),
        client.from("comments").select("id,work_id").in("work_id", ids),
      ]);
    if (likeError) throw new Error(likeError.message);
    if (commentError) throw new Error(commentError.message);
    return works.map((work) => ({
      ...work,
      author_pen_name: work.profiles?.pen_name ?? "佚名",
      author_bio: work.profiles?.bio ?? "",
      author_role: work.profiles?.role ?? "member",
      like_count: likes.filter((like) => like.work_id === work.id).length,
      comment_count: comments.filter((comment) => comment.work_id === work.id)
        .length,
      liked_by_current_user: Boolean(
        sessionValue &&
          likes.some(
            (like) =>
              like.work_id === work.id &&
              like.user_id === sessionValue.profile.id,
          ),
      ),
    }));
  };

  const service = {
    mode: "supabase",
    isDemo: false,

    async getSession() {
      const client = await getClient();
      const { data, error } = await client.auth.getSession();
      if (error) throw new Error(error.message);
      const user = data.session?.user;
      if (!user) {
        cachedSession = null;
        return null;
      }
      if (!cachedSession || cachedSession.user.id !== user.id) {
        cachedSession = await buildCachedSession(client, user);
      }
      return clone(cachedSession);
    },

    async signIn({ studentNumber, password }) {
      const client = await getClient();
      const { data, error } = await client.auth.signInWithPassword({
        email: studentNumberToAuthEmail(studentNumber),
        password,
      });
      if (error) throw new Error(error.message);
      cachedSession = await buildCachedSession(client, data.user);
      return clone(cachedSession);
    },

    async signUp({ studentNumber, password, penName, recoveryEmail, captchaToken }) {
      if (!validatePassword(password)) {
        throw new Error("密码至少八位，且需要同时包含字母和数字");
      }
      const client = await getClient();
      const { data, error } = await client.auth.signUp({
        email: studentNumberToAuthEmail(studentNumber),
        password,
        options: { data: { pen_name: requireText(penName, "笔名", 24) } },
      });
      if (error) throw new Error(error.message);
      if (!data.session) {
        throw new Error("注册已提交，请先在 Supabase 关闭邮件确认后再登录");
      }
      cachedSession = await buildCachedSession(client, data.user);
      let deliveryWarning = null;
      if (recoveryEmail) {
        try {
          const bindResult = await invokeFunction("account-email", {
            action: "request-bind",
            email: recoveryEmail,
            captchaToken,
          });
          cachedSession.accountSecurity = {
            state: "pending",
            maskedEmail: bindResult?.maskedEmail ?? null,
            nextSendAt: bindResult?.nextSendAt ?? null,
          };
        } catch {
          deliveryWarning = "验证码邮件暂时无法送达，稍后可在账号安全中重新发送";
        }
      }
      const result = clone(cachedSession);
      if (deliveryWarning) result.deliveryWarning = deliveryWarning;
      return result;
    },

    async signOut() {
      const client = await getClient();
      const { error } = await client.auth.signOut();
      if (error) throw new Error(error.message);
      cachedSession = null;
    },

    async listWorks() {
      const client = await getClient();
      const { data, error } = await client
        .from("works")
        .select("*, profiles!works_author_id_fkey(pen_name,bio,role)")
        .eq("status", "published")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return enrichRemoteWorks(client, data ?? []);
    },

    async getWork(workId) {
      const client = await getClient();
      const { data: work, error } = await client
        .from("works")
        .select("*, profiles!works_author_id_fkey(id,pen_name,bio,role,created_at)")
        .eq("id", workId)
        .eq("status", "published")
        .single();
      if (error) throw new Error(error.code === "PGRST116" ? "作品不存在" : error.message);
      const [enriched] = await enrichRemoteWorks(client, [work]);
      const { data: comments, error: commentsError } = await client
        .from("comments")
        .select("*, profiles!comments_user_id_fkey(pen_name,role)")
        .eq("work_id", workId)
        .order("created_at", { ascending: true });
      if (commentsError) throw new Error(commentsError.message);
      return {
        ...enriched,
        author_profile: work.profiles,
        comments: (comments ?? []).map((comment) => ({
          ...comment,
          user_pen_name: comment.profiles?.pen_name ?? "佚名",
          user_role: comment.profiles?.role ?? "member",
        })),
      };
    },

    async createWork(input) {
      const current = await requireRemoteSession();
      const content = requireText(input.content, "正文", 50000);
      const client = await getClient();
      const { data, error } = await client
        .from("works")
        .insert({
          author_id: current.profile.id,
          title: requireText(input.title, "标题", 80),
          excerpt:
            String(input.excerpt ?? "").trim() || createExcerpt(content, 96),
          content,
          category: requirePublishableCategory(input.category),
        })
        .select("*, profiles!works_author_id_fkey(pen_name,bio,role)")
        .single();
      if (error) throw new Error(error.message);
      const [work] = await enrichRemoteWorks(client, [data]);
      return work;
    },

    async deleteWork(workId) {
      await requireRemoteSession();
      const client = await getClient();
      const { error } = await client.from("works").delete().eq("id", workId);
      if (error) throw new Error(error.message);
    },

    async toggleLike(workId) {
      const current = await requireRemoteSession();
      const client = await getClient();
      const { data: existing, error: findError } = await client
        .from("likes")
        .select("work_id")
        .eq("work_id", workId)
        .eq("user_id", current.profile.id)
        .maybeSingle();
      if (findError) throw new Error(findError.message);
      let liked;
      if (existing) {
        const { error } = await client
          .from("likes")
          .delete()
          .eq("work_id", workId)
          .eq("user_id", current.profile.id);
        if (error) throw new Error(error.message);
        liked = false;
      } else {
        const { error } = await client
          .from("likes")
          .insert({ work_id: workId, user_id: current.profile.id });
        if (error) throw new Error(error.message);
        liked = true;
      }
      const { count, error: countError } = await client
        .from("likes")
        .select("*", { count: "exact", head: true })
        .eq("work_id", workId);
      if (countError) throw new Error(countError.message);
      return { liked, likeCount: count ?? 0 };
    },

    async addComment(workId, content, parentId = null) {
      const current = await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client
        .from("comments")
        .insert({
          work_id: workId,
          user_id: current.profile.id,
          parent_id: parentId,
          content: requireText(content, "评论", 2000),
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return {
        ...data,
        user_pen_name: current.profile.pen_name,
        user_role: current.profile.role,
      };
    },

    async deleteComment(commentId) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("soft_delete_comment", {
        target_comment_id: commentId,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async getProfile(profileId) {
      const client = await getClient();
      const { data: profile, error } = await client
        .from("profiles")
        .select("*")
        .eq("id", profileId)
        .single();
      if (error) throw new Error(error.code === "PGRST116" ? "作者不存在" : error.message);
      const works = (await service.listWorks()).filter(
        (work) => work.author_id === profileId,
      );
      const { count, error: commentError } = await client
        .from("comments")
        .select("*", { count: "exact", head: true })
        .eq("user_id", profileId);
      if (commentError) throw new Error(commentError.message);
      return {
        ...profile,
        works,
        work_count: works.length,
        total_likes: works.reduce(
          (total, work) => total + work.like_count,
          0,
        ),
        comment_count: count ?? 0,
      };
    },

    async updateProfile(profileId, input) {
      const current = await requireRemoteSession();
      if (current.profile.id !== profileId) {
        throw new Error("没有权限修改该资料");
      }
      const penName = requireText(
        input.penName ?? current.profile.pen_name,
        "笔名",
        24,
      );
      const client = await getClient();
      const { data, error } = await client.rpc("update_own_profile", {
        requested_pen_name: penName,
        requested_bio: String(input.bio ?? "").trim().slice(0, 240),
      });
      if (error) throw new Error(error.message);
      const profile = Array.isArray(data) ? data[0] : data;
      if (!profile) throw new Error("公开资料没有更新");
      cachedSession.profile = profile;
      return profile;
    },

    async getSiteSettings() {
      const client = await getClient();
      const { data, error } = await client
        .from("site_settings")
        .select("key,value");
      if (error) throw new Error(error.message);
      return Object.fromEntries((data ?? []).map((item) => [item.key, item.value]));
    },

    async setFeatured(workId, featured) {
      await requireRemoteSession();
      const client = await getClient();
      const { data, error } = await client.rpc("set_work_featured", {
        target_work_id: workId,
        featured: Boolean(featured),
      });
      if (error) throw new Error(error.message);
      return {
        id: data?.id ?? workId,
        is_featured: data?.is_featured ?? Boolean(featured),
      };
    },

    async getAccountSecurityStatus() {
      const current = await requireRemoteSession();
      return invokeFunction("account-email", { action: "status" });
    },

    async requestRecoveryEmail(email, captchaToken) {
      await requireRemoteSession();
      return invokeFunction("account-email", {
        action: "request-bind",
        email,
        captchaToken,
      });
    },

    async verifyRecoveryEmail(code) {
      await requireRemoteSession();
      return invokeFunction("account-email", { action: "verify-bind", code });
    },

    async reauthenticate(currentPassword) {
      const client = await getClient();
      if (!cachedSession?.user?.email) throw new Error("请先登录");
      const { data, error } = await client.auth.signInWithPassword({
        email: cachedSession.user.email,
        password: currentPassword,
      });
      if (error) throw new Error(error.message);
      cachedSession = await buildCachedSession(client, data.user);
      return true;
    },

    async requestRecoveryEmailChange(newEmail, captchaToken) {
      await requireRemoteSession();
      return invokeFunction("account-email", {
        action: "request-change",
        newEmail,
        captchaToken,
      });
    },

    async confirmRecoveryEmailChangeOld(code) {
      await requireRemoteSession();
      return invokeFunction("account-email", {
        action: "confirm-change-old",
        code,
      });
    },

    async confirmRecoveryEmailChangeNew(code) {
      await requireRemoteSession();
      return invokeFunction("account-email", {
        action: "confirm-change-new",
        code,
      });
    },

    async requestPasswordRecovery(studentNumber, captchaToken) {
      return invokeFunction("password-recovery", {
        action: "request",
        studentNumber,
        captchaToken,
      });
    },

    async completePasswordRecovery(studentNumber, code, newPassword, captchaToken) {
      return invokeFunction("password-recovery", {
        action: "complete",
        studentNumber,
        code,
        newPassword,
        captchaToken,
      });
    },

    canWrite() {
      return cachedSession?.accountSecurity?.state === "verified";
    },
  };

  return service;
}

export function createDataService(config = {}) {
  const hasRemoteConfig =
    config.mode === "supabase" &&
    Boolean(config.supabaseUrl) &&
    Boolean(config.supabasePublishableKey ?? config.supabaseAnonKey);
  return hasRemoteConfig
    ? createSupabaseService(config)
    : createDemoService(config);
}
