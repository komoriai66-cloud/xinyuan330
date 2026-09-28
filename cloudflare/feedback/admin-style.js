export const ADMIN_STYLE = `
*{box-sizing:border-box}
:root{color-scheme:light}
body{margin:0;background:#fff;color:#111;font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit}
button{appearance:none;cursor:pointer}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #111;outline-offset:2px}
[hidden]{display:none!important}
header{display:flex;align-items:center;justify-content:space-between;height:68px;padding:0 28px;border-bottom:1px solid #eaeaea;background:#fff;font-size:18px;font-weight:700;letter-spacing:-.01em}
header button{padding:8px 14px;border:1px solid #dedede;border-radius:10px;background:#fff;color:#111;font-size:13px;font-weight:600}
#login{width:min(calc(100% - 40px),440px);margin:10vh auto;padding:32px;border:1px solid #e5e5e5;border-radius:20px;background:#fff}
#login h2{margin:0 0 8px;font-size:24px;letter-spacing:-.03em}
#login .meta{margin:0 0 24px}
#login label{display:block;font-size:13px;font-weight:600}
#login input{display:block;width:100%;height:48px;margin:8px 0 16px;padding:0 14px;border:1px solid #d8d8d8;border-radius:12px;background:#fff;color:#111}
#login .primary{width:100%}
#login-notice,#notice{color:#a02232;font-size:13px}
#login-notice:not(:empty),#notice:not(:empty){padding:10px 0}
main{display:grid;grid-template-columns:minmax(290px,360px) minmax(0,1fr);height:calc(100dvh - 68px);max-width:1500px;margin:auto;background:#fff}
aside{display:flex;flex-direction:column;min-width:0;min-height:0;padding:18px 14px;border-right:1px solid #eaeaea;background:#fff}
nav{display:flex;gap:3px;align-items:center;flex-wrap:wrap;margin:0 0 18px;border-bottom:1px solid #eaeaea}
nav button{min-height:42px;padding:8px 10px;border:0;border-bottom:2px solid transparent;border-radius:0;background:#fff;color:#777;font-size:13px;font-weight:600}
nav button.active{border-bottom-color:#111;color:#111}
nav #refresh{margin-left:auto}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
.toolbar input,.toolbar select,.note textarea,.reply textarea{border:1px solid #d8d8d8;border-radius:11px;background:#fff;color:#111}
aside .toolbar{margin:0 0 12px}
aside .toolbar input{flex:1;min-width:150px}
.toolbar input,.toolbar select{min-height:40px;padding:8px 10px;font-size:13px}
.toolbar button,.note button,#more{min-height:38px;padding:8px 12px;border:1px solid #d8d8d8;border-radius:9px;background:#fff;color:#111;font-size:13px;font-weight:600}
.list{flex:1;min-height:0;overflow-y:auto}
.list button{display:block;width:100%;min-height:72px;padding:13px 12px;border:0;border-bottom:1px solid #eee;border-radius:0;background:#fff;color:#111;text-align:left}
.list button:hover,.list button.selected{background:#f7f7f7}
.list button.selected{box-shadow:inset 3px 0 #111}
.list b,.list small{display:block}
.list b{overflow:hidden;font-size:14px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
.list small{margin-top:4px;color:#777;font-size:11px;line-height:1.4}
#more{margin-top:12px}
section{display:flex;flex-direction:column;min-width:0;min-height:0;padding:24px 28px;background:#fff}
#detail>h2{margin:0 0 4px;font-size:22px;letter-spacing:-.025em}
.meta{color:#777;font-size:12px}
#detail>.meta{margin-bottom:12px}
#detail>.toolbar{padding:10px 0;border-bottom:1px solid #eee}
#detail>.toolbar label{font-size:13px;font-weight:600}
#detail>.toolbar select{margin-left:6px}
#detail .danger{margin-left:auto;color:#111}
.note{margin:6px 0 12px;padding:0;border:0;color:#444;font-size:13px}
.note summary{width:fit-content;padding:7px 0;cursor:pointer}
.note label{display:block;margin:8px 0}
.note textarea{display:block;width:100%;min-height:80px;margin:8px 0;padding:10px;resize:vertical}
#messages{display:flex;flex:1;flex-direction:column;gap:16px;min-height:140px;overflow-y:auto;padding:18px 4px 20px}
.message{width:fit-content;max-width:min(82%,560px);margin:0;padding:11px 14px;border:1px solid #dedede;border-radius:6px 17px 17px 17px;background:#fff;color:#111;white-space:pre-wrap;overflow-wrap:anywhere}
.message.admin{align-self:flex-end;border-color:#111;border-radius:17px 6px 17px 17px;background:#111;color:#fff}
.message small{display:block;margin-bottom:5px;color:#777;font-size:11px}
.message.admin small{color:#d0d0d0}
.message button{display:block;margin-top:8px;padding:6px 9px;border:1px solid currentColor;border-radius:8px;background:transparent;color:inherit;font-size:12px}
.message img{display:block;max-width:100%;max-height:360px;margin-top:8px;border-radius:8px}
.reply{margin:0 -28px -24px;padding:14px 28px 24px;border-top:1px solid #eaeaea;background:#fff}
.reply label{display:block;color:#555;font-size:12px;font-weight:600}
.reply textarea{display:block;width:100%;min-height:80px;max-height:220px;margin:7px 0 10px;padding:12px;resize:vertical;font-size:15px}
.primary{min-height:42px;padding:9px 16px;border:1px solid #111;border-radius:10px;background:#111;color:#fff;font-weight:600}
.primary:hover{background:#303030}
.mobile-back{display:none}
@media(max-width:760px){header{height:58px;padding:0 18px;font-size:16px}main{display:block;height:calc(100dvh - 58px)}aside{height:100%;padding:12px 14px;border:0}main.thread-open aside{display:none}main:not(.thread-open) section{display:none}section{height:100%;padding:14px 18px}.mobile-back{display:block;width:fit-content;margin:0 0 12px;padding:4px 0;border:0;background:#fff;color:#111;font-size:14px;font-weight:600}.reply{margin:0 -18px -14px;padding:12px 18px calc(14px + env(safe-area-inset-bottom))}.message{max-width:88%}}
`;
