FROM golang:1.27 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /eroded-landing .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /eroded-landing /eroded-landing
USER 10001:10001
ENV HTTP_ADDR=:8080
EXPOSE 8080
ENTRYPOINT ["/eroded-landing"]
