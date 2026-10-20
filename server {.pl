server {
listen 80;
server_name marketech.thrivewoo.com;

return 301 https://$host$request_uri;

}

server {
listen 443 ssl;
server_name marketech.thrivewoo.com;


# SSL
ssl_certificate /etc/letsencrypt/live/thrivewoo.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/thrivewoo.com/privkey.pem;

# Angular Frontend
root /home/ec2-user/marketing-AI/frontend/dist/frontend/browser;
index index.html;

# Angular Routing
location / {
    try_files $uri $uri/ /index.html;
}
# API Proxy
location /api/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;

    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}

}