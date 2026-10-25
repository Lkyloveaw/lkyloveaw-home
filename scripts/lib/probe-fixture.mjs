import {createServer} from 'node:http'

/** Real, local HTTP responses shared by the probe acceptance scripts. */
export async function startProbeFixture() {
  const server=createServer((req,res)=>{
    if(req.url==='/timeout') return
    res.writeHead(req.url==='/status/503'?503:200)
    res.end('probe fixture')
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {
    url:`http://127.0.0.1:${server.address().port}/`,
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))},
  }
}
