const cp=require("child_process");
const PS="C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const op=process.argv[2];
let input="";
process.stdin.on("data",function(d){input+=d;});
process.stdin.on("end",function(){
  try{
    const expr=op==="protect"
      ? "[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)"
      : "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)";
    const cmd="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$r="+expr+";[Console]::Out.Write([Convert]::ToBase64String($r))";
    const r=cp.spawnSync(PS,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",cmd],{input:input.trim(),encoding:"utf8",maxBuffer:8388608,windowsHide:true});
    if(r.error){process.stderr.write("helper spawn error code="+(r.error.code||"")+" msg="+String(r.error.message||""));process.exit(2);}
    if(r.status!==0){process.stderr.write("helper exit="+r.status+" stderr="+String(r.stderr||"").slice(0,300));process.exit(3);}
    process.stdout.write(String(r.stdout||"").trim());
  }catch(e){process.stderr.write("helper throw "+String((e&&e.message)||e));process.exit(4);}
});