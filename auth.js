const mode=location.pathname==='/setup'?'setup':location.pathname==='/activate'?'activate':'login';
// Keep the fragment until activation succeeds so refreshing does not lose the invitation.
const invitation=location.hash.slice(1);
if(mode==='login')history.replaceState(null,'',location.pathname);
const el=id=>document.getElementById(id);
if(mode!=='login'){
  el('title').textContent=mode==='setup'?'Set up your owner account':'Set your staff password';
  el('help').textContent='Choose a unique password of at least 12 characters. Your password is stored securely as a hash.';
  el('password').autocomplete='new-password';el('password').minLength=12;el('confirmation').required=true;
  el('confirmField').hidden=false;el('loginLink').hidden=false;el('submit').textContent='Create password and continue';
  if(mode==='activate'){el('usernameField').hidden=true;el('username').required=false;}
  if(!invitation){el('message').textContent='This link is incomplete. Reopen the full invitation shared by the owner, including the part after #. If you already created your password, use Back to sign in.';el('submit').disabled=true;}
}
el('authForm').addEventListener('submit',async event=>{
  event.preventDefault();el('message').textContent='';
  if(mode!=='login'&&el('password').value!==el('confirmation').value){el('message').textContent='Passwords do not match.';return;}
  el('submit').disabled=true;
  try{
    const response=await fetch(`/api/${mode}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:el('username').value.trim(),password:el('password').value,token:invitation})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Unable to sign in.');
    history.replaceState(null,'',location.pathname);
    location.replace('/');
  }catch(err){el('message').textContent=err.message;el('submit').disabled=false;}
});
