import { spawnSync } from 'node:child_process';

// A fixed program, never a command assembled from an owner/model path. Every
// ancestor stays open without FILE_SHARE_DELETE until enumeration/read finishes.
const PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
try {
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SharedRead {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
  public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFile(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint flags);
 static Info Check(SafeFileHandle h,string p) {
  Info i; if(h.IsInvalid || !GetFileInformationByHandle(h,out i) || (i.Attributes & 0x400)!=0 || ((i.Attributes & 0x10)==0 && i.Links!=1)) throw new Exception("unsafe-entry");
  var b=new StringBuilder(32768); var n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);
  if(n==0 || n>=b.Capacity || !String.Equals(b.ToString(),"\\\\?\\"+p,StringComparison.OrdinalIgnoreCase)) throw new Exception("unsafe-path");
  return i;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,IntPtr info,uint size);
 public static string Run(string root,string relative,string operation,int maxBytes,string expected="",string replacement="",string backup="") {
  if(root.StartsWith("\\\\") || root.Length<4 || root[1]!=':') throw new Exception("invalid-root");
  string target=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
  if(!String.Equals(target,root,StringComparison.OrdinalIgnoreCase) && !target.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new Exception("outside-root");
  var handles=new List<SafeFileHandle>();
  try {
   string current=Path.GetPathRoot(target); string[] parts=target.Substring(current.Length).Split('\\');
   SafeFileHandle last=null; Info info=new Info();
   foreach(string part in parts) {
    current=Path.Combine(current,part);
    // FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS; no write/delete sharing.
    var h=CreateFile(current,((operation=="write" || operation=="delete") && current==target) ? 0xC0010000u : 0x80000000u,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    handles.Add(h); info=Check(h,current); last=h;
   }
   if(operation=="validate-directory") { if((info.Attributes&0x10)==0) throw new Exception("not-directory"); return "ok"; }
   if(operation=="validate-file") { if((info.Attributes&0x10)!=0) throw new Exception("not-file"); return "ok"; }
   if(operation=="list") {
    if((info.Attributes&0x10)==0) throw new Exception("not-directory");
    var entries=new List<string>();
    foreach(var entry in Directory.EnumerateFileSystemEntries(target)) {
     using(var h=CreateFile(entry,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      try { var child=Check(h,entry); entries.Add(((child.Attributes&0x10)!=0 ? "d" : "f")+"\t"+Path.GetFileName(entry)); } catch { }
     }
     if(entries.Count>=201) break;
    }
    return String.Join("\n",entries);
   }
   if((info.Attributes&0x10)!=0 || info.SizeHigh!=0 || info.SizeLow>maxBytes) throw new Exception("invalid-file");
   bool mutation=operation=="write" || operation=="delete";
   using(var stream=new FileStream(last,mutation ? FileAccess.ReadWrite : FileAccess.Read)) {
    var bytes=new byte[maxBytes+1]; int total=0,n;
    while(total<bytes.Length && (n=stream.Read(bytes,total,bytes.Length-total))>0) total+=n;
    if(total>maxBytes) throw new Exception("file-too-large");
    Check(last,target);
    string original=Convert.ToBase64String(bytes,0,total);
    if(!mutation) return original;
    if(original!=expected || backup.StartsWith("\\\\") || backup.Length<4 || backup[1]!=':') throw new Exception("changed-file");
    var changed=Convert.FromBase64String(replacement); if(changed.Length>maxBytes) throw new Exception("file-too-large");
    string backupDirectory=Path.GetDirectoryName(backup), bc=Path.GetPathRoot(backupDirectory);
    foreach(string part in backupDirectory.Substring(bc.Length).Split('\\')) {
     bc=Path.Combine(bc,part);var bh=CreateFile(bc,0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);handles.Add(bh);
     if((Check(bh,bc).Attributes&0x10)==0) throw new Exception("invalid-backup");
    }
    using(var saved=new FileStream(backup,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
     Check(saved.SafeFileHandle,backup);saved.Write(bytes,0,total);saved.Flush(true);
    }
    Check(last,target);
    if(operation=="delete") {
     IntPtr disposition=Marshal.AllocHGlobal(1);
     try {Marshal.WriteByte(disposition,1);if(!SetFileInformationByHandle(last,4,disposition,1)) throw new Exception("delete-failed");}
     finally {Marshal.FreeHGlobal(disposition);}
    } else {
     stream.Position=0;stream.Write(changed,0,changed.Length);stream.SetLength(changed.Length);stream.Flush(true);
    }
    return "ok";
   }
  } finally { foreach(var h in handles) h.Dispose(); }
 }
}
'@
 $q = [Console]::In.ReadToEnd() | ConvertFrom-Json
 $result = [SharedRead]::Run([string]$q.root,[string]$q.relative,[string]$q.operation,[int]$q.maxBytes,[string]$q.expected,[string]$q.replacement,[string]$q.backup)
 [Console]::Out.Write((@{ok=$true;result=$result} | ConvertTo-Json -Compress))
} catch { [Console]::Out.Write('{"ok":false}'); exit 1 }
`;
export function windowsSafeOperation(root: string, relative: string, operation: 'read'|'list'|'validate-file'|'validate-directory', maxBytes = 262144): string {
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(PROGRAM,'utf16le').toString('base64')], {
    input:JSON.stringify({root,relative,operation,maxBytes}), encoding:'utf8', windowsHide:true, timeout:30000, maxBuffer:2*1024*1024,
  });
  try { const out = JSON.parse(result.stdout.replace(/^\uFEFF/,'')); if (result.status === 0 && out.ok && typeof out.result === 'string') return out.result; } catch {}
  throw new Error('안전한 Windows 파일 확인에 실패했습니다');
}

export function windowsSafeMutation(root:string,relative:string,operation:'write'|'delete',expected:string,replacement:string,backup:string):void {
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(PROGRAM,'utf16le').toString('base64')],{
    input:JSON.stringify({root,relative,operation,maxBytes:262144,expected,replacement,backup}),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024,
  });
  try {const output=JSON.parse(result.stdout.replace(/^\uFEFF/,''));if(result.status===0 && output.ok && output.result==='ok')return;}catch{}
  throw new Error('안전한 Windows 파일 변경에 실패했습니다');
}
