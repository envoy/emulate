import type { RouteContext } from "@envoy/emulators-core";
import type { Context } from "@envoy/emulators-core";
import { getAwsStore } from "../store.js";
import {
  awsXmlResponse,
  awsErrorXml,
  generateAwsId,
  generateMessageId,
  getAccountId,
  parseQueryString,
  escapeXml,
} from "../helpers.js";
import { randomBytes, createHash } from "crypto";

export function iamRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const aws = () => getAwsStore(store);
  const accountId = getAccountId();

  // IAM actions via POST with Action parameter
  app.post("/iam/", async (c) => {
    const body = await c.req.text();
    const params = parseQueryString(body);
    const action = params["Action"] ?? c.req.query("Action") ?? "";

    switch (action) {
      case "CreateUser":
        return createUser(c, params);
      case "GetUser":
        return getUser(c, params);
      case "DeleteUser":
        return deleteUser(c, params);
      case "ListUsers":
        return listUsers(c);
      case "CreateAccessKey":
        return createAccessKey(c, params);
      case "ListAccessKeys":
        return listAccessKeys(c, params);
      case "DeleteAccessKey":
        return deleteAccessKey(c, params);
      case "CreateRole":
        return createRole(c, params);
      case "GetRole":
        return getRole(c, params);
      case "DeleteRole":
        return deleteRole(c, params);
      case "ListRoles":
        return listRoles(c);
      default:
        return awsErrorXml(c, "InvalidAction", `The action ${action} is not valid for this endpoint.`, 400);
    }
  });

  // STS endpoints. The AWS SDKs resolve a configured endpoint of ".../sts" and
  // then post to it directly, so the path arrives without a trailing slash.
  const stsHandler = async (c: Context) => {
    const body = await c.req.text();
    const params = parseQueryString(body);
    const action = params["Action"] ?? c.req.query("Action") ?? "";

    switch (action) {
      case "GetCallerIdentity":
        return getCallerIdentity(c);
      case "AssumeRole":
        return assumeRole(c, params);
      case "AssumeRoleWithWebIdentity":
        return assumeRoleWithWebIdentity(c, params);
      default:
        return awsErrorXml(c, "InvalidAction", `The action ${action} is not valid for this endpoint.`, 400);
    }
  };

  app.post("/sts", stsHandler);
  app.post("/sts/", stsHandler);

  function createUser(c: Context, params: Record<string, string>) {
    const userName = params["UserName"] ?? "";
    if (!userName) {
      return awsErrorXml(c, "ValidationError", "The request must contain the parameter UserName.", 400);
    }

    const existing = aws().iamUsers.findOneBy("user_name", userName);
    if (existing) {
      return awsErrorXml(c, "EntityAlreadyExists", `User with name ${escapeXml(userName)} already exists.`, 409);
    }

    const userId = generateAwsId("AIDA");
    const path = params["Path"] ?? "/";
    const arn = `arn:aws:iam::${accountId}:user${path}${userName}`;

    aws().iamUsers.insert({
      user_name: userName,
      user_id: userId,
      arn,
      path,
      access_keys: [],
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateUserResponse>
  <CreateUserResult>
    <User>
      <Path>${escapeXml(path)}</Path>
      <UserName>${escapeXml(userName)}</UserName>
      <UserId>${userId}</UserId>
      <Arn>${escapeXml(arn)}</Arn>
      <CreateDate>${new Date().toISOString()}</CreateDate>
    </User>
  </CreateUserResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</CreateUserResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getUser(c: Context, params: Record<string, string>) {
    const userName = params["UserName"] ?? "";
    const user = aws().iamUsers.findOneBy("user_name", userName);
    if (!user) {
      return awsErrorXml(c, "NoSuchEntity", `The user with name ${escapeXml(userName)} cannot be found.`, 404);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetUserResponse>
  <GetUserResult>
    <User>
      <Path>${escapeXml(user.path)}</Path>
      <UserName>${escapeXml(user.user_name)}</UserName>
      <UserId>${user.user_id}</UserId>
      <Arn>${escapeXml(user.arn)}</Arn>
      <CreateDate>${user.created_at}</CreateDate>
    </User>
  </GetUserResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetUserResponse>`;
    return awsXmlResponse(c, xml);
  }

  function deleteUser(c: Context, params: Record<string, string>) {
    const userName = params["UserName"] ?? "";
    const user = aws().iamUsers.findOneBy("user_name", userName);
    if (!user) {
      return awsErrorXml(c, "NoSuchEntity", `The user with name ${escapeXml(userName)} cannot be found.`, 404);
    }

    aws().iamUsers.delete(user.id);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteUserResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</DeleteUserResponse>`;
    return awsXmlResponse(c, xml);
  }

  function listUsers(c: Context) {
    const users = aws().iamUsers.all();
    const usersXml = users
      .map(
        (u) => `      <member>
        <Path>${escapeXml(u.path)}</Path>
        <UserName>${escapeXml(u.user_name)}</UserName>
        <UserId>${u.user_id}</UserId>
        <Arn>${escapeXml(u.arn)}</Arn>
        <CreateDate>${u.created_at}</CreateDate>
      </member>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListUsersResponse>
  <ListUsersResult>
    <IsTruncated>false</IsTruncated>
    <Users>
${usersXml}
    </Users>
  </ListUsersResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</ListUsersResponse>`;
    return awsXmlResponse(c, xml);
  }

  function createAccessKey(c: Context, params: Record<string, string>) {
    const userName = params["UserName"] ?? "";
    const user = aws().iamUsers.findOneBy("user_name", userName);
    if (!user) {
      return awsErrorXml(c, "NoSuchEntity", `The user with name ${escapeXml(userName)} cannot be found.`, 404);
    }

    const accessKeyId = "AKIA" + randomBytes(8).toString("hex").toUpperCase();
    const secretAccessKey = randomBytes(30).toString("base64");

    const keys = [
      ...user.access_keys,
      { access_key_id: accessKeyId, secret_access_key: secretAccessKey, status: "Active" as const },
    ];
    aws().iamUsers.update(user.id, { access_keys: keys });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateAccessKeyResponse>
  <CreateAccessKeyResult>
    <AccessKey>
      <UserName>${escapeXml(userName)}</UserName>
      <AccessKeyId>${accessKeyId}</AccessKeyId>
      <Status>Active</Status>
      <SecretAccessKey>${secretAccessKey}</SecretAccessKey>
      <CreateDate>${new Date().toISOString()}</CreateDate>
    </AccessKey>
  </CreateAccessKeyResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</CreateAccessKeyResponse>`;
    return awsXmlResponse(c, xml);
  }

  function listAccessKeys(c: Context, params: Record<string, string>) {
    const userName = params["UserName"] ?? "";
    const user = aws().iamUsers.findOneBy("user_name", userName);
    if (!user) {
      return awsErrorXml(c, "NoSuchEntity", `The user with name ${escapeXml(userName)} cannot be found.`, 404);
    }

    const keysXml = user.access_keys
      .map(
        (k) => `      <member>
        <UserName>${escapeXml(userName)}</UserName>
        <AccessKeyId>${k.access_key_id}</AccessKeyId>
        <Status>${k.status}</Status>
      </member>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAccessKeysResponse>
  <ListAccessKeysResult>
    <IsTruncated>false</IsTruncated>
    <AccessKeyMetadata>
${keysXml}
    </AccessKeyMetadata>
  </ListAccessKeysResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</ListAccessKeysResponse>`;
    return awsXmlResponse(c, xml);
  }

  function deleteAccessKey(c: Context, params: Record<string, string>) {
    const userName = params["UserName"] ?? "";
    const accessKeyId = params["AccessKeyId"] ?? "";
    const user = aws().iamUsers.findOneBy("user_name", userName);
    if (!user) {
      return awsErrorXml(c, "NoSuchEntity", `The user with name ${escapeXml(userName)} cannot be found.`, 404);
    }

    const keys = user.access_keys.filter((k) => k.access_key_id !== accessKeyId);
    aws().iamUsers.update(user.id, { access_keys: keys });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteAccessKeyResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</DeleteAccessKeyResponse>`;
    return awsXmlResponse(c, xml);
  }

  function createRole(c: Context, params: Record<string, string>) {
    const roleName = params["RoleName"] ?? "";
    if (!roleName) {
      return awsErrorXml(c, "ValidationError", "The request must contain the parameter RoleName.", 400);
    }

    const existing = aws().iamRoles.findOneBy("role_name", roleName);
    if (existing) {
      return awsErrorXml(c, "EntityAlreadyExists", `Role with name ${escapeXml(roleName)} already exists.`, 409);
    }

    const roleId = generateAwsId("AROA");
    const path = params["Path"] ?? "/";
    const arn = `arn:aws:iam::${accountId}:role${path}${roleName}`;
    const assumeRolePolicy = params["AssumeRolePolicyDocument"] ?? "{}";
    const description = params["Description"] ?? "";

    aws().iamRoles.insert({
      role_name: roleName,
      role_id: roleId,
      arn,
      path,
      assume_role_policy_document: assumeRolePolicy,
      description,
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CreateRoleResponse>
  <CreateRoleResult>
    <Role>
      <Path>${escapeXml(path)}</Path>
      <RoleName>${escapeXml(roleName)}</RoleName>
      <RoleId>${roleId}</RoleId>
      <Arn>${escapeXml(arn)}</Arn>
      <CreateDate>${new Date().toISOString()}</CreateDate>
      <AssumeRolePolicyDocument>${encodeURIComponent(assumeRolePolicy)}</AssumeRolePolicyDocument>
      <Description>${escapeXml(description)}</Description>
    </Role>
  </CreateRoleResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</CreateRoleResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getRole(c: Context, params: Record<string, string>) {
    const roleName = params["RoleName"] ?? "";
    const role = aws().iamRoles.findOneBy("role_name", roleName);
    if (!role) {
      return awsErrorXml(c, "NoSuchEntity", `The role with name ${escapeXml(roleName)} cannot be found.`, 404);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetRoleResponse>
  <GetRoleResult>
    <Role>
      <Path>${escapeXml(role.path)}</Path>
      <RoleName>${escapeXml(role.role_name)}</RoleName>
      <RoleId>${role.role_id}</RoleId>
      <Arn>${escapeXml(role.arn)}</Arn>
      <CreateDate>${role.created_at}</CreateDate>
      <AssumeRolePolicyDocument>${encodeURIComponent(role.assume_role_policy_document)}</AssumeRolePolicyDocument>
      <Description>${escapeXml(role.description)}</Description>
    </Role>
  </GetRoleResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetRoleResponse>`;
    return awsXmlResponse(c, xml);
  }

  function deleteRole(c: Context, params: Record<string, string>) {
    const roleName = params["RoleName"] ?? "";
    const role = aws().iamRoles.findOneBy("role_name", roleName);
    if (!role) {
      return awsErrorXml(c, "NoSuchEntity", `The role with name ${escapeXml(roleName)} cannot be found.`, 404);
    }

    aws().iamRoles.delete(role.id);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteRoleResponse>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</DeleteRoleResponse>`;
    return awsXmlResponse(c, xml);
  }

  function listRoles(c: Context) {
    const roles = aws().iamRoles.all();
    const rolesXml = roles
      .map(
        (r) => `      <member>
        <Path>${escapeXml(r.path)}</Path>
        <RoleName>${escapeXml(r.role_name)}</RoleName>
        <RoleId>${r.role_id}</RoleId>
        <Arn>${escapeXml(r.arn)}</Arn>
        <CreateDate>${r.created_at}</CreateDate>
        <Description>${escapeXml(r.description)}</Description>
      </member>`,
      )
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListRolesResponse>
  <ListRolesResult>
    <IsTruncated>false</IsTruncated>
    <Roles>
${rolesXml}
    </Roles>
  </ListRolesResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</ListRolesResponse>`;
    return awsXmlResponse(c, xml);
  }

  function getCallerIdentity(c: Context) {
    const authUser = c.get("authUser") as { login?: string } | undefined;
    const userName = authUser?.login ?? "admin";
    const arn = `arn:aws:iam::${accountId}:user/${userName}`;

    // Return stable UserId from the IAM store when available
    const user = aws().iamUsers.findOneBy("user_name", userName);
    const userId = user?.user_id ?? generateAwsId("AIDA");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetCallerIdentityResponse>
  <GetCallerIdentityResult>
    <Arn>${escapeXml(arn)}</Arn>
    <UserId>${userId}</UserId>
    <Account>${accountId}</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`;
    return awsXmlResponse(c, xml);
  }

  function assumeRole(c: Context, params: Record<string, string>) {
    const roleArn = params["RoleArn"] ?? "";
    const sessionName = params["RoleSessionName"] ?? "session";

    // Find the role by ARN
    const role = aws()
      .iamRoles.all()
      .find((r) => r.arn === roleArn);
    if (!role) {
      return awsErrorXml(c, "NoSuchEntity", `The role specified cannot be found.`, 404);
    }

    const accessKeyId = "ASIA" + randomBytes(8).toString("hex").toUpperCase();
    const secretAccessKey = randomBytes(30).toString("base64");
    const sessionToken = randomBytes(64).toString("base64");
    const expiration = new Date(Date.now() + 3600 * 1000).toISOString();

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleResponse>
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>${accessKeyId}</AccessKeyId>
      <SecretAccessKey>${secretAccessKey}</SecretAccessKey>
      <SessionToken>${sessionToken}</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>${roleArn}/${sessionName}</Arn>
      <AssumedRoleId>${role.role_id}:${sessionName}</AssumedRoleId>
    </AssumedRoleUser>
  </AssumeRoleResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</AssumeRoleResponse>`;
    return awsXmlResponse(c, xml);
  }

  // The web identity token is echoed back as a subject, never verified. A real
  // OIDC token carries the subject in its "sub" claim, so read that when the
  // token happens to look like a JWT and fall back to a stable digest when it
  // does not. This emulates the response shape, not the trust model.
  function subjectFromWebIdentityToken(token: string): string {
    const segments = token.split(".");
    if (segments.length === 3) {
      try {
        const claims: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
        if (claims && typeof claims === "object") {
          const sub = (claims as Record<string, unknown>)["sub"];
          if (typeof sub === "string" && sub.length > 0) return sub;
        }
      } catch {
        // Not a JWT after all. Fall through to the digest.
      }
    }
    return `emulate:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  }

  function assumeRoleWithWebIdentity(c: Context, params: Record<string, string>) {
    const roleArn = params["RoleArn"] ?? "";
    if (!roleArn) {
      return awsErrorXml(c, "ValidationError", "The request must contain the parameter RoleArn.", 400);
    }

    const token = params["WebIdentityToken"] ?? "";
    if (!token) {
      return awsErrorXml(c, "ValidationError", "The request must contain the parameter WebIdentityToken.", 400);
    }

    const sessionName = params["RoleSessionName"] || "web-identity-session";

    // Unlike AssumeRole, the role need not be seeded. Callers point at whatever
    // role ARN their production configuration names, and the emulator issues
    // credentials for it regardless.
    const role = aws()
      .iamRoles.all()
      .find((r) => r.arn === roleArn);
    const roleId = role?.role_id ?? generateAwsId("AROA");

    const accessKeyId = "ASIA" + randomBytes(8).toString("hex").toUpperCase();
    const secretAccessKey = randomBytes(30).toString("base64");
    const sessionToken = randomBytes(64).toString("base64");
    const expiration = new Date(Date.now() + 3600 * 1000).toISOString();
    const subject = subjectFromWebIdentityToken(token);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleWithWebIdentityResponse>
  <AssumeRoleWithWebIdentityResult>
    <SubjectFromWebIdentityToken>${escapeXml(subject)}</SubjectFromWebIdentityToken>
    <Audience>${escapeXml(params["ProviderId"] || "emulate")}</Audience>
    <Provider>${escapeXml(params["ProviderId"] || "emulate")}</Provider>
    <Credentials>
      <AccessKeyId>${accessKeyId}</AccessKeyId>
      <SecretAccessKey>${secretAccessKey}</SecretAccessKey>
      <SessionToken>${sessionToken}</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>${escapeXml(roleArn)}/${escapeXml(sessionName)}</Arn>
      <AssumedRoleId>${roleId}:${escapeXml(sessionName)}</AssumedRoleId>
    </AssumedRoleUser>
  </AssumeRoleWithWebIdentityResult>
  <ResponseMetadata><RequestId>${generateMessageId()}</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`;
    return awsXmlResponse(c, xml);
  }
}
