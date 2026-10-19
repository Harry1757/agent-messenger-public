import { createHash } from 'node:crypto';

export function isSensitivePath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(p => /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|\.git-credentials|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore))$/i.test(p));
}
// Match credential field names, not unrelated names such as tokenBudget or
// passwordMinLength. Known token formats are scanned independently of field names.
const credentialKey='(?:password|passwd|pwd|secret|token|api[_ -]?key|access[_ -]?key|secret[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|private[_ -]?key|authorization|aws[_ -]?secret[_ -]?access[_ -]?key|aws[_ -]?access[_ -]?key[_ -]?id|(?:database|db)[_ -]?password)';
const assignment=new RegExp('(?<![A-Za-z0-9_$-])(["\']?)'+credentialKey+'\\1\\s*[:=]\\s*(?:"([^"\\r\\n]*)"|\'([^\'\\r\\n]*)\'|`([^`]*)`|([^\\s,;}]+))','gi');
const environmentReference=/^(?:process\.env|import\.meta\.env)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][A-Za-z_][A-Za-z0-9_]*['"]\])$/;
export function inspectSensitive(text: string, relativePath: string): {sensitive: boolean; redacted: string; digest: string} {
  const digest = createHash('sha256').update(text).digest('hex');
  if (isSensitivePath(relativePath)) return {sensitive:true,redacted:'[민감한 파일 내용은 공유하지 않습니다]',digest};
  let sensitive = false;
  let redacted = text;
  const patterns = [
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9_+.\/=:-]{8,}/gi,
    /\b(?:[a-z][a-z0-9+.-]*):\/\/[^\s/:@]+:[^\s/@]+@/gi,
    /([?&](?:token|api[_-]?key|access[_-]?token|secret|password)=)[^\s&#"']+/gi,
  ];
  for (const pattern of patterns) redacted = redacted.replace(pattern, () => { sensitive = true; return '[REDACTED]'; });
  redacted=redacted.replace(assignment,(match,_quote,double,single,template,bare)=>{
    const literal=double??single??template;
    if(literal!==undefined && literal.length===0)return match;
    if(bare!==undefined && (/^(?:true|false|null|undefined|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(bare) || environmentReference.test(bare)))return match;
    sensitive=true;return '[REDACTED]';
  });
  return {sensitive,redacted,digest};
}
