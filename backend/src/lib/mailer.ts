import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

type Transport = { send(msg: MailMessage): Promise<void> };

function createTransport(): Transport {
  const m = config.mail;
  if (m.transport === 'console' || !m.host) {
    if (config.isProduction) {
      // 운영에서 메일 설정이 없으면 비밀번호 재설정이 동작하지 않으므로 명확히 알린다.
      console.error('[mail] SMTP_HOST 가 설정되지 않아 메일을 보낼 수 없습니다.');
      return {
        async send() {
          throw new Error('mail transport not configured');
        },
      };
    }
    return {
      async send(msg) {
        // 개발용: 메일 내용을 콘솔에 출력 (production 에서는 절대 사용하지 않음)
        console.info(`\n[mail:dev] to=${msg.to}\n[mail:dev] subject=${msg.subject}\n${msg.text}\n`);
      },
    };
  }

  const transporter = nodemailer.createTransport({
    host: m.host,
    port: m.port,
    secure: m.secure,
    auth: m.user ? { user: m.user, pass: m.pass } : undefined,
  });
  return {
    async send(msg) {
      await transporter.sendMail({ from: m.from, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}

let transport: Transport | null = null;

export async function sendMail(msg: MailMessage): Promise<void> {
  transport ??= createTransport();
  await transport.send(msg);
}

export async function sendTempPasswordMail(to: string, nickname: string, tempPassword: string, ttlMinutes: number) {
  await sendMail({
    to,
    subject: '[다이어트 기록] 임시 비밀번호 안내',
    text: [
      `${nickname}님, 안녕하세요.`,
      '',
      '요청하신 임시 비밀번호를 보내드립니다.',
      '',
      `임시 비밀번호: ${tempPassword}`,
      '',
      `- 유효 시간: ${ttlMinutes}분, 1회용입니다.`,
      '- 임시 비밀번호로 로그인하면 새 비밀번호를 설정해야 합니다.',
      '- 기존 비밀번호도 계속 사용할 수 있습니다. 본인이 요청하지 않았다면 이 메일을 무시하세요.',
      '',
      `로그인: ${config.appBaseUrl}/login`,
    ].join('\n'),
  });
}

export async function sendPasswordChangedMail(to: string, nickname: string) {
  await sendMail({
    to,
    subject: '[다이어트 기록] 비밀번호가 변경되었습니다',
    text: [
      `${nickname}님, 안녕하세요.`,
      '',
      '계정의 비밀번호가 변경되었습니다. 보안을 위해 모든 기기에서 로그아웃되었습니다.',
      '',
      '본인이 변경하지 않았다면 즉시 비밀번호 재설정을 진행해 주세요.',
      `${config.appBaseUrl}/forgot`,
    ].join('\n'),
  });
}
