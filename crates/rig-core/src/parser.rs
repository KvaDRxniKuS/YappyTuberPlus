use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum UnaryOp {
    Neg,
    Pos,
    Not,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    Eq,
    NotEq,
    And,
    Or,
}

#[derive(Debug, Clone)]
pub enum Expr {
    Number(f64),
    /// Строковый литерал: `"дождь"`. Числовые формулы строк не принимают —
    /// они нужны командам воспроизведения и тексту.
    Text(String),
    Name(String),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Ternary {
        condition: Box<Expr>,
        yes: Box<Expr>,
        no: Box<Expr>,
    },
    Member {
        expr: Box<Expr>,
        name: String,
    },
    Call {
        id: u32,
        name: String,
        args: Vec<Expr>,
    },
    /// Поле входа модуля с аргументом: `twitch.chat.message(-1)`.
    ///
    /// `subject` — `модуль.вход`, `field` — что именно читаем (`message`,
    /// `user`, `min`, `max`, `label`). Аргумент — смещение по истории: 0 или
    /// пусто — последнее сообщение, −1 — предыдущее.
    FieldCall {
        subject: String,
        field: String,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
    Text(String),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    LParen,
    RParen,
    Comma,
    Dot,
    Question,
    Colon,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    EqEq,
    NotEq,
    And,
    Or,
    Not,
    End,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    position: usize,
}

fn lex(source: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let kind = match c {
            '+' => {
                i += 1;
                TokenKind::Plus
            }
            '-' => {
                i += 1;
                TokenKind::Minus
            }
            '*' => {
                i += 1;
                TokenKind::Star
            }
            '/' => {
                i += 1;
                TokenKind::Slash
            }
            '%' => {
                i += 1;
                TokenKind::Percent
            }
            '^' => {
                i += 1;
                TokenKind::Caret
            }
            '(' => {
                i += 1;
                TokenKind::LParen
            }
            ')' => {
                i += 1;
                TokenKind::RParen
            }
            ',' => {
                i += 1;
                TokenKind::Comma
            }
            '?' => {
                i += 1;
                TokenKind::Question
            }
            ':' => {
                i += 1;
                TokenKind::Colon
            }
            '<' => {
                i += 1;
                if i < chars.len() && chars[i] == '=' {
                    i += 1;
                    TokenKind::LessEq
                } else {
                    TokenKind::Less
                }
            }
            '>' => {
                i += 1;
                if i < chars.len() && chars[i] == '=' {
                    i += 1;
                    TokenKind::GreaterEq
                } else {
                    TokenKind::Greater
                }
            }
            '=' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    i += 2;
                    TokenKind::EqEq
                } else {
                    return Err(format!("неожиданный '=' на позиции {}", i + 1));
                }
            }
            '!' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    i += 2;
                    TokenKind::NotEq
                } else {
                    i += 1;
                    TokenKind::Not
                }
            }
            '"' => {
                i += 1;
                let mut value = String::new();
                let mut closed = false;
                while i < chars.len() {
                    let current = chars[i];
                    i += 1;
                    match current {
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\\' => {
                            let escaped = match chars.get(i) {
                                Some('n') => '\n',
                                Some('t') => '\t',
                                Some('"') => '"',
                                Some('\\') => '\\',
                                _ => {
                                    return Err(format!(
                                        "неизвестная escape-последовательность на позиции {}",
                                        i
                                    ))
                                }
                            };
                            i += 1;
                            value.push(escaped);
                        }
                        other => value.push(other),
                    }
                }
                if !closed {
                    return Err("строка не закрыта: нет '\"'".into());
                }
                TokenKind::Text(value)
            }
            '.' if i + 1 < chars.len() && chars[i + 1].is_ascii_digit() => {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i < chars.len() && chars[i] == 'e' || i < chars.len() && chars[i] == 'E' {
                    return Err("экспоненциальная запись после '.5' пока не поддерживается".into());
                }
                let value: String = chars[start..i].iter().collect();
                TokenKind::Number(value.parse().map_err(|_| "некорректное число")?)
            }
            '.' => {
                i += 1;
                TokenKind::Dot
            }
            '0'..='9' => {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i < chars.len() && chars[i] == '.' {
                    i += 1;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                    i += 1;
                    if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                        i += 1;
                    }
                    let exponent_start = i;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                    if exponent_start == i {
                        return Err(format!("некорректная экспонента на позиции {}", start + 1));
                    }
                }
                let value: String = chars[start..i].iter().collect();
                TokenKind::Number(value.parse().map_err(|_| "некорректное число")?)
            }
            'a'..='z' | 'A'..='Z' | '_' => {
                i += 1;
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                match ident.as_str() {
                    "and" => TokenKind::And,
                    "or" => TokenKind::Or,
                    "not" => TokenKind::Not,
                    _ => TokenKind::Ident(ident),
                }
            }
            _ => {
                // Кириллица в идентификаторе — самая частая опечатка: в скрипте
                // имена латинские, а текст пишется в кавычках.
                let hint = if c.is_alphabetic() && !c.is_ascii() {
                    ": имена в скрипте — латиница, а текст пишется в кавычках, например text(\"привет\")"
                } else {
                    ""
                };
                return Err(format!(
                    "неизвестный символ '{}' на позиции {}{}",
                    c,
                    i + 1,
                    hint
                ));
            }
        };
        tokens.push(Token {
            kind,
            position: start,
        });
    }
    tokens.push(Token {
        kind: TokenKind::End,
        position: source.len(),
    });
    Ok(tokens)
}

struct ExpressionParser {
    tokens: Vec<Token>,
    current: usize,
    call_id: u32,
}

impl ExpressionParser {
    fn new(source: &str) -> Result<Self, String> {
        Ok(Self {
            tokens: lex(source)?,
            current: 0,
            call_id: 0,
        })
    }

    fn parse(mut self) -> Result<Expr, String> {
        let expr = self.ternary()?;
        if self.peek() != &TokenKind::End {
            return Err(format!(
                "неожиданный токен на позиции {}",
                self.position() + 1
            ));
        }
        Ok(expr)
    }

    fn peek(&self) -> &TokenKind {
        &self.tokens[self.current].kind
    }
    fn position(&self) -> usize {
        self.tokens[self.current].position
    }
    fn advance(&mut self) -> TokenKind {
        let token = self.tokens[self.current].kind.clone();
        if self.current + 1 < self.tokens.len() {
            self.current += 1;
        }
        token
    }
    fn check(&self, expected: &TokenKind) -> bool {
        self.peek() == expected
    }
    fn consume(&mut self, expected: &TokenKind, message: &str) -> Result<(), String> {
        if self.check(expected) {
            self.advance();
            Ok(())
        } else {
            Err(format!("{} на позиции {}", message, self.position() + 1))
        }
    }

    fn ternary(&mut self) -> Result<Expr, String> {
        let mut expr = self.or()?;
        if self.check(&TokenKind::Question) {
            self.advance();
            let yes = self.ternary()?;
            self.consume(&TokenKind::Colon, "ожидалось ':'")?;
            let no = self.ternary()?;
            expr = Expr::Ternary {
                condition: Box::new(expr),
                yes: Box::new(yes),
                no: Box::new(no),
            };
        }
        Ok(expr)
    }

    fn or(&mut self) -> Result<Expr, String> {
        let mut expr = self.and()?;
        while self.check(&TokenKind::Or) {
            self.advance();
            expr = Expr::Binary {
                op: BinaryOp::Or,
                left: Box::new(expr),
                right: Box::new(self.and()?),
            };
        }
        Ok(expr)
    }

    fn and(&mut self) -> Result<Expr, String> {
        let mut expr = self.comparison()?;
        while self.check(&TokenKind::And) {
            self.advance();
            expr = Expr::Binary {
                op: BinaryOp::And,
                left: Box::new(expr),
                right: Box::new(self.comparison()?),
            };
        }
        Ok(expr)
    }

    fn comparison(&mut self) -> Result<Expr, String> {
        let mut expr = self.additive()?;
        loop {
            let op = match self.peek() {
                TokenKind::Less => BinaryOp::Less,
                TokenKind::LessEq => BinaryOp::LessEq,
                TokenKind::Greater => BinaryOp::Greater,
                TokenKind::GreaterEq => BinaryOp::GreaterEq,
                TokenKind::EqEq => BinaryOp::Eq,
                TokenKind::NotEq => BinaryOp::NotEq,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary {
                op,
                left: Box::new(expr),
                right: Box::new(self.additive()?),
            };
        }
        Ok(expr)
    }

    fn additive(&mut self) -> Result<Expr, String> {
        let mut expr = self.multiplicative()?;
        loop {
            let op = match self.peek() {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Sub,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary {
                op,
                left: Box::new(expr),
                right: Box::new(self.multiplicative()?),
            };
        }
        Ok(expr)
    }

    fn multiplicative(&mut self) -> Result<Expr, String> {
        let mut expr = self.unary()?;
        loop {
            let op = match self.peek() {
                TokenKind::Star => BinaryOp::Mul,
                TokenKind::Slash => BinaryOp::Div,
                TokenKind::Percent => BinaryOp::Mod,
                _ => break,
            };
            self.advance();
            expr = Expr::Binary {
                op,
                left: Box::new(expr),
                right: Box::new(self.unary()?),
            };
        }
        Ok(expr)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        let op = match self.peek() {
            TokenKind::Minus => Some(UnaryOp::Neg),
            TokenKind::Plus => Some(UnaryOp::Pos),
            TokenKind::Not => Some(UnaryOp::Not),
            _ => None,
        };
        if let Some(op) = op {
            self.advance();
            return Ok(Expr::Unary {
                op,
                expr: Box::new(self.unary()?),
            });
        }
        self.power()
    }

    fn power(&mut self) -> Result<Expr, String> {
        let left = self.postfix()?;
        if self.check(&TokenKind::Caret) {
            self.advance();
            let right = self.unary()?;
            return Ok(Expr::Binary {
                op: BinaryOp::Pow,
                left: Box::new(left),
                right: Box::new(right),
            });
        }
        Ok(left)
    }

    fn postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.primary()?;
        loop {
            if self.check(&TokenKind::Dot) {
                self.advance();
                let name = match self.advance() {
                    TokenKind::Ident(name) => name,
                    _ => {
                        return Err(format!(
                            "ожидалось имя поля на позиции {}",
                            self.position() + 1
                        ))
                    }
                };
                expr = Expr::Member {
                    expr: Box::new(expr),
                    name,
                };
                continue;
            }
            if self.check(&TokenKind::LParen) {
                // `twitch.chat.message(-1)`: путь из трёх частей — это поле
                // входа модуля, а не встроенная функция. Путь запоминаем
                // строкой, чтобы ядро нашло вход и его паспорт.
                if let Some((subject, field)) = field_path(&expr) {
                    self.advance();
                    let mut args = Vec::new();
                    if !self.check(&TokenKind::RParen) {
                        loop {
                            args.push(self.ternary()?);
                            if !self.check(&TokenKind::Comma) {
                                break;
                            }
                            self.advance();
                        }
                    }
                    self.consume(&TokenKind::RParen, "ожидалось ')'")?;
                    expr = Expr::FieldCall { subject, field, args };
                    continue;
                }
                let name = match expr {
                    Expr::Name(name) => name,
                    _ => return Err("вызывать можно только встроенную функцию".into()),
                };
                self.advance();
                let mut args = Vec::new();
                if !self.check(&TokenKind::RParen) {
                    loop {
                        args.push(self.ternary()?);
                        if !self.check(&TokenKind::Comma) {
                            break;
                        }
                        self.advance();
                    }
                }
                self.consume(&TokenKind::RParen, "ожидалось ')'")?;
                let id = self.call_id;
                self.call_id += 1;
                expr = Expr::Call { id, name, args };
                continue;
            }
            break;
        }
        Ok(expr)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.advance() {
            TokenKind::Number(value) => Ok(Expr::Number(value)),
            TokenKind::Text(value) => Ok(Expr::Text(value)),
            TokenKind::Ident(name) => Ok(Expr::Name(name)),
            TokenKind::LParen => {
                let expr = self.ternary()?;
                self.consume(&TokenKind::RParen, "ожидалось ')'")?;
                Ok(expr)
            }
            _ => Err(format!(
                "ожидалось выражение на позиции {}",
                self.position() + 1
            )),
        }
    }
}

pub fn parse_expression(source: &str) -> Result<Expr, String> {
    ExpressionParser::new(source)?.parse()
}

/// Условие, по которому срабатывает блок события.
#[derive(Debug, Clone, PartialEq)]
pub enum EventKind {
    /// Значение перешло из нуля в единицу: нажатие, начало речи.
    Down,
    /// Значение вернулось в ноль: отпускание.
    Up,
    /// Значение изменилось с прошлого кадра (аналоговые входы).
    Change,
    /// Вход держится дольше `сек` — один раз за удержание.
    Hold(f64),
    /// Вход отпущен дольше `сек` — один раз за отпускание.
    Relax(f64),
}

/// Откуда берётся событие.
#[derive(Debug, Clone, PartialEq)]
pub enum EventSource {
    /// Первый кадр после запуска: `on start { … }`.
    Start,
    /// Прямая подписка на вход модуля: `on mouse.left.down { … }`.
    Input { source: String, kind: EventKind },
    /// Именованное событие из `trigger`: `on kick { … }`.
    Named(String),
}

/// Куда пишет присваивание.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssignTarget {
    /// Своё имя: параметр объекта или глобальная переменная.
    Local(String),
    /// Чужой объект: `head.rotation = …`.
    Foreign { object: String, param: String },
}

/// Объявление именованного события: `trigger kick = mouse.left.down`.
#[derive(Debug, Clone, PartialEq)]
pub struct TriggerDecl {
    pub name: String,
    pub source: String,
    pub kind: EventKind,
}

/// Один оператор в теле блока события.
///
/// Присваивание меняет параметр, команда (`play()`, `seek(2)`, `text("…")`)
/// управляет медиа-объектом или текстом. Команды пишутся только внутри
/// `on …` — на верхнем уровне скрипта живут формулы.
#[derive(Debug, Clone)]
pub enum Statement {
    Assign(AssignTarget, Arc<Expr>),
    Call(Arc<Expr>),
}

/// Блок `on … { имя = выражение … }`.
#[derive(Debug, Clone)]
pub struct EventBlock {
    pub source: EventSource,
    pub body: Vec<Statement>,
}

/// Ошибка разбора с местом в тексте: редактор подчёркивает этот диапазон.
#[derive(Debug, Clone, PartialEq)]
pub struct ScriptError {
    /// Строка с единицы.
    pub line: usize,
    /// Столбец с единицы.
    pub column: usize,
    /// Длина подчёркивания в символах.
    pub length: usize,
    pub message: String,
}

impl ScriptError {
    fn new(line: usize, column: usize, length: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            column,
            length: length.max(1),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ScriptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "строка {}, столбец {}: {}",
            self.line, self.column, self.message
        )
    }
}

/// Разобранный скрипт: присваивания, блоки событий и объявления `trigger`.
#[derive(Debug, Default)]
pub struct Script {
    pub assignments: Vec<(AssignTarget, Arc<Expr>)>,
    pub events: Vec<EventBlock>,
    pub triggers: Vec<TriggerDecl>,
}

fn valid_identifier(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Ключевое слово в начале строки отдельным словом: `on`, `trigger`.
fn keyword_at<'a>(text: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(keyword)?;
    match rest.chars().next() {
        Some(c) if c.is_ascii_alphanumeric() || c == '_' => None,
        _ => Some(rest),
    }
}

/// Тип условия из текста: `down`, `hold(0.5)`, `relax(1)`.
fn kind_from(name: &str, argument: Option<&str>) -> Result<EventKind, String> {
    let seconds = match name {
        "hold" | "relax" => match argument.map(str::trim) {
            Some(value) if !value.is_empty() => {
                let parsed = value.parse::<f64>().map_err(|_| {
                    format!("время в '{}' должно быть числом", name)
                })?;
                if !parsed.is_finite() || parsed < 0.0 {
                    return Err(format!("время в '{}' не может быть отрицательным", name));
                }
                parsed
            }
            _ => 0.0,
        },
        _ => {
            if argument.is_some() {
                return Err(format!("у события '{}' нет аргументов", name));
            }
            0.0
        }
    };
    Ok(match name {
        "down" => EventKind::Down,
        "up" => EventKind::Up,
        "change" => EventKind::Change,
        "hold" => EventKind::Hold(seconds),
        "relax" => EventKind::Relax(seconds),
        other => {
            return Err(format!(
                "неизвестный тип события '{}'; ожидалось down, up, change, hold(сек) или relax(сек)",
                other
            ))
        }
    })
}

/// `mouse.left.hold(0.5)` → (`mouse.left`, `hold`, `0.5`).
fn split_event_path(text: &str) -> (&str, &str, Option<&str>) {
    if text.ends_with(')') {
        if let Some(open) = text.rfind('(') {
            let before = &text[..open];
            let argument = &text[open + 1..text.len() - 1];
            let trimmed = before.trim_end();
            let name_start = trimmed
                .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .map(|index| index + 1)
                .unwrap_or(0);
            return (&before[..name_start], &trimmed[name_start..], Some(argument));
        }
    }
    match text.rfind('.') {
        Some(index) => (&text[..index], &text[index + 1..], None),
        None => ("", text, None),
    }
}

/// Разбор условия события: `start`, `mouse.left.down`, `mic.talking.hold(0.5)`, `kick`.
fn parse_event_source(raw: &str) -> Result<EventSource, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("пустое условие события".into());
    }
    // Событие записывается одной формой: `on модуль.вход.тип`. Префикса
    // `event.` больше нет — он дублировал `on` и путал: в скрипте остаются
    // только входы модулей и их типы.
    if text.starts_with("event.") {
        return Err("заголовок события пишется как 'on модуль.вход.тип { … }': префикс 'event.' не нужен".into());
    }
    let path = text;
    if !path.contains('.') {
        if !valid_identifier(path) {
            return Err(format!("некорректное имя события '{}'", raw.trim()));
        }
        return Ok(if path == "start" {
            EventSource::Start
        } else {
            EventSource::Named(path.to_string())
        });
    }
    let (head, name, argument) = split_event_path(path);
    let head = head.trim().trim_end_matches('.');
    let parts: Vec<&str> = head.split('.').collect();
    if parts.len() != 2 || !valid_identifier(parts[0].trim()) || !valid_identifier(parts[1].trim()) {
        return Err(format!(
            "ожидалось 'модуль.вход.тип' или имя события, а не '{}'",
            raw.trim()
        ));
    }
    let kind = kind_from(name.trim(), argument)?;
    Ok(EventSource::Input {
        source: format!("{}.{}", parts[0].trim(), parts[1].trim()),
        kind,
    })
}

/// Разбор цели присваивания: `x`, `speed` или `head.rotation`.
fn parse_target(text: &str) -> Result<AssignTarget, String> {
    let trimmed = text.trim();
    let parts: Vec<&str> = trimmed.split('.').collect();
    match parts.len() {
        1 if valid_identifier(trimmed) => Ok(AssignTarget::Local(trimmed.to_string())),
        2 if valid_identifier(parts[0].trim()) && valid_identifier(parts[1].trim()) => {
            Ok(AssignTarget::Foreign {
                object: parts[0].trim().to_string(),
                param: parts[1].trim().to_string(),
            })
        }
        _ => Err(format!(
            "некорректная цель '{}'; ожидалось 'имя' или 'объект.параметр'",
            trimmed
        )),
    }
}

/// Позиция из сообщения парсера выражений: «ожидалось выражение на позиции 5».
fn position_from_message(message: &str) -> usize {
    const MARKER: &str = "на позиции ";
    if let Some(index) = message.rfind(MARKER) {
        let digits: String = message[index + MARKER.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(value) = digits.parse::<usize>() {
            return value.saturating_sub(1);
        }
    }
    0
}

/// Один оператор `цель = выражение` с точным местом ошибки.
fn parse_assignment(
    text: &str,
    line: usize,
    column: usize,
    next_call_id: &mut u32,
) -> Result<(AssignTarget, Arc<Expr>), ScriptError> {
    let equal = text.find('=').ok_or_else(|| {
        ScriptError::new(
            line,
            column,
            text.len(),
            "ожидалось присваивание 'имя = выражение'",
        )
    })?;
    if text[equal..].starts_with("==") {
        return Err(ScriptError::new(
            line,
            column + equal,
            2,
            "ожидалось присваивание 'имя = выражение'",
        ));
    }
    let target_text = &text[..equal];
    let expression_text = &text[equal + 1..];
    let target = parse_target(target_text).map_err(|message| {
        ScriptError::new(line, column, target_text.trim_end().len(), message)
    })?;
    let expression = expression_text.trim();
    if expression.is_empty() {
        return Err(ScriptError::new(
            line,
            column + equal + 1,
            1,
            "справа от '=' нет выражения",
        ));
    }
    let expression_column =
        column + equal + 1 + (expression_text.len() - expression_text.trim_start().len());
    let expr = parse_expression(expression).map_err(|message| {
        let shift = position_from_message(&message);
        ScriptError::new(
            line,
            expression_column + shift,
            expression.len() - shift.min(expression.len()),
            message,
        )
    })?;
    let mut counter = CountCalls(*next_call_id);
    counter.visit(&expr);
    *next_call_id = counter.0;
    Ok((target, Arc::new(expr)))
}

/// Похоже ли начало строки на вызов функции: `play()`, `seek(2)`, `text("…")`.
fn looks_like_call(text: &str) -> bool {
    let head = text
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(text.len());
    head > 0 && text[head..].starts_with('(') && text.ends_with(')')
}

/// Оператор тела блока события: присваивание или команда.
///
/// Команда — это голая функция в строке: `play()`, `play("дождь")`,
/// `seek(1.5)`, `text("привет")`. Аргумент-строка нужна, чтобы управлять
/// чужим объектом из скрипта-контроллера.
fn parse_statement(
    text: &str,
    line: usize,
    column: usize,
    next_call_id: &mut u32,
) -> Result<Statement, ScriptError> {
    let trimmed = text.trim();
    if looks_like_call(trimmed) {
        let expr = parse_expression(trimmed).map_err(|message| {
            let shift = position_from_message(&message);
            ScriptError::new(
                line,
                column + shift,
                trimmed.len() - shift.min(trimmed.len()),
                message,
            )
        })?;
        if !matches!(expr, Expr::Call { .. }) {
            return Err(ScriptError::new(
                line,
                column,
                trimmed.len(),
                "ожидалась команда вида 'play()'",
            ));
        }
        let mut counter = CountCalls(*next_call_id);
        counter.visit(&expr);
        *next_call_id = counter.0;
        return Ok(Statement::Call(Arc::new(expr)));
    }
    let (target, expression) = parse_assignment(trimmed, line, column, next_call_id)?;
    Ok(Statement::Assign(target, expression))
}

/// Разбор скрипта: присваивания, блоки `on …` и объявления `trigger`.
///
/// Строки разбираются по одной, поэтому ошибка всегда знает свою строку и
/// столбец — редактор подчёркивает ровно это место.
pub fn parse_script(source: &str) -> Result<Script, ScriptError> {
    let mut script = Script::default();
    let mut next_call_id = 0u32;
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0usize;
    while index < lines.len() {
        let line_number = index + 1;
        let raw = lines[index];
        let code = raw.split("//").next().unwrap_or("");
        let trimmed = code.trim();
        if trimmed.is_empty() {
            index += 1;
            continue;
        }
        let column = code.len() - code.trim_start().len() + 1;

        // `trigger имя = модуль.вход.тип`
        if let Some(rest) = keyword_at(trimmed, "trigger") {
            let body = rest.trim();
            let equal = body.find('=').ok_or_else(|| {
                ScriptError::new(
                    line_number,
                    column,
                    trimmed.len(),
                    "ожидалось 'trigger имя = модуль.вход.тип'",
                )
            })?;
            let name = body[..equal].trim();
            if !valid_identifier(name) {
                return Err(ScriptError::new(
                    line_number,
                    column + "trigger".len() + 1,
                    name.len(),
                    "имя события — латиница, цифры и '_'",
                ));
            }
            if name == "start" {
                return Err(ScriptError::new(
                    line_number,
                    column + "trigger".len() + 1,
                    name.len(),
                    "имя 'start' занято встроенным событием",
                ));
            }
            let value_text = &body[equal + 1..];
            let value = value_text.trim();
            let value_column = column + equal + 1 + (value_text.len() - value_text.trim_start().len());
            if value.is_empty() {
                return Err(ScriptError::new(
                    line_number,
                    value_column,
                    1,
                    "после '=' ожидалось 'модуль.вход.тип'",
                ));
            }
            let parsed = parse_event_source(value).map_err(|message| {
                ScriptError::new(line_number, value_column, value.len(), message)
            })?;
            let (source_name, kind) = match parsed {
                EventSource::Input { source, kind } => (source, kind),
                _ => {
                    return Err(ScriptError::new(
                        line_number,
                        value_column,
                        value.len(),
                        "trigger ждёт 'модуль.вход.тип'",
                    ))
                }
            };
            if script.triggers.iter().any(|entry| entry.name == name) {
                return Err(ScriptError::new(
                    line_number,
                    column,
                    trimmed.len(),
                    format!("событие '{}' уже объявлено", name),
                ));
            }
            script.triggers.push(TriggerDecl {
                name: name.to_string(),
                source: source_name,
                kind,
            });
            index += 1;
            continue;
        }

        // Блок события: только `on <условие> { … }`.
        //
        // Второй формы (`event.…` без `on`) больше нет: два синтаксиса одного
        // и того же сбивали с толку. Строка `event.x = 5` остаётся
        // присваиванием чужому объекту с именем `event`.
        if trimmed.starts_with("event.") && trimmed.contains('{') {
            return Err(ScriptError::new(
                line_number,
                column,
                trimmed.len(),
                "заголовок события пишется как 'on модуль.вход.тип { … }': префикс 'event.' не нужен",
            ));
        }
        let event_block = keyword_at(trimmed, "on").map(|rest| (rest, "on".len()));
        if let Some((rest, prefix_len)) = event_block {
            let open = rest.find('{').ok_or_else(|| {
                ScriptError::new(line_number, column, trimmed.len(), "у блока события нет '{'")
            })?;
            let header_text = &rest[..open];
            let header = header_text.trim();
            let header_column = column + prefix_len + (header_text.len() - header_text.trim_start().len());
            if header.is_empty() {
                return Err(ScriptError::new(
                    line_number,
                    header_column,
                    trimmed.len(),
                    "после 'on' ожидалось условие: 'start', 'имя' или 'модуль.вход.тип'",
                ));
            }
            let event_source = parse_event_source(header).map_err(|message| {
                ScriptError::new(line_number, header_column, header.len(), message)
            })?;

            let mut body_lines: Vec<(usize, usize, String)> = Vec::new();
            let mut closed = false;
            let after_open = &rest[open + 1..];
            match after_open.find('}') {
                Some(close) => {
                    let text = after_open[..close].trim();
                    if !text.is_empty() {
                        body_lines.push((line_number, column, text.to_string()));
                    }
                    closed = true;
                    // После закрывающей скобки на той же строке ничего не пишется:
                    // иначе `on start {} text("…")` молча терялся, и человек видел
                    // «ни ошибки, ни результата».
                    let rest_after = &after_open[close + 1..];
                    let tail = rest_after.trim_start();
                    if !tail.is_empty() {
                        let offset = prefix_len
                            + open
                            + 1
                            + close
                            + 1
                            + (rest_after.len() - tail.len());
                        return Err(ScriptError::new(
                            line_number,
                            column + offset,
                            tail.trim_end().len(),
                            "после '}' блока события ничего не пишется: каждое действие — отдельной строкой",
                        ));
                    }
                }
                None => {
                    let text = after_open.trim();
                    if !text.is_empty() {
                        body_lines.push((line_number, column, text.to_string()));
                    }
                    while index + 1 < lines.len() {
                        index += 1;
                        let next_raw = lines[index];
                        let next_code = next_raw.split("//").next().unwrap_or("");
                        let next_trimmed = next_code.trim();
                        let next_column = next_code.len() - next_code.trim_start().len() + 1;
                        if next_trimmed == "}" {
                            closed = true;
                            break;
                        }
                        if let Some(text) = next_trimmed.strip_suffix('}') {
                            let text = text.trim();
                            if !text.is_empty() {
                                body_lines.push((index + 1, next_column, text.to_string()));
                            }
                            closed = true;
                            break;
                        }
                        if !next_trimmed.is_empty() {
                            body_lines.push((index + 1, next_column, next_trimmed.to_string()));
                        }
                    }
                }
            }
            if !closed {
                return Err(ScriptError::new(
                    line_number,
                    column,
                    trimmed.len(),
                    "блок события не закрыт '}'",
                ));
            }
            let mut body = Vec::new();
            for (body_line, body_column, text) in body_lines {
                body.push(parse_statement(
                    &text,
                    body_line,
                    body_column,
                    &mut next_call_id,
                )?);
            }
            script.events.push(EventBlock {
                source: event_source,
                body,
            });
            index += 1;
            continue;
        }

        if looks_like_call(trimmed) {
            return Err(ScriptError::new(
                line_number,
                column,
                trimmed.len(),
                "команда выполняется только внутри блока события: on start { play() }",
            ));
        }
        let statement = parse_assignment(trimmed, line_number, column, &mut next_call_id)?;
        if let AssignTarget::Local(name) = &statement.0 {
            let duplicate = script.assignments.iter().any(|(existing, _)| {
                matches!(existing, AssignTarget::Local(other) if other == name)
            });
            if duplicate {
                return Err(ScriptError::new(
                    line_number,
                    column,
                    name.len(),
                    format!("'{}' присваивается дважды", name),
                ));
            }
        }
        script.assignments.push(statement);
        index += 1;
    }
    Ok(script)
}

/// Путь `модуль.вход.поле` → (`модуль.вход`, `поле`).
///
/// Возвращает `None` для всего остального: `max(a, b)` остаётся встроенной
/// функцией, а `vec(1, 2).x` по-прежнему нельзя вызвать.
fn field_path(expr: &Expr) -> Option<(String, String)> {
    let Expr::Member { expr: inner, name } = expr else {
        return None;
    };
    let Expr::Member { expr: root, name: input } = inner.as_ref() else {
        return None;
    };
    let Expr::Name(module) = root.as_ref() else {
        return None;
    };
    Some((format!("{}.{}", module, input), name.clone()))
}

struct CountCalls(u32);
impl CountCalls {
    fn visit(&mut self, expr: &Expr) {
        match expr {
            Expr::Call { id, args, .. } => {
                self.0 = self.0.max(*id + 1);
                for arg in args {
                    self.visit(arg);
                }
            }
            Expr::FieldCall { args, .. } => {
                for arg in args {
                    self.visit(arg);
                }
            }
            Expr::Unary { expr, .. } => self.visit(expr),
            Expr::Binary { left, right, .. } => {
                self.visit(left);
                self.visit(right);
            }
            Expr::Ternary { condition, yes, no } => {
                self.visit(condition);
                self.visit(yes);
                self.visit(no);
            }
            Expr::Member { expr, .. } => self.visit(expr),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_is_right_associative() {
        let expr = parse_expression("2 ^ 3 ^ 2").unwrap();
        match expr {
            Expr::Binary {
                op: BinaryOp::Pow,
                right,
                ..
            } => {
                assert!(matches!(
                    *right,
                    Expr::Binary {
                        op: BinaryOp::Pow,
                        ..
                    }
                ));
            }
            _ => panic!("expected power"),
        }
    }

    #[test]
    fn comments_and_vector_members_parse() {
        let script =
            parse_script("x = follow(offset, parent).x // movement\ny = vec(1, 2).y").unwrap();
        assert_eq!(script.assignments.len(), 2);
    }

    #[test]
    fn event_blocks_parse() {
        let script = parse_script(
            "a = 0\non mouse.left.down {\n  a = !a\n  b = 1\n}\n",
        )
        .unwrap();
        assert_eq!(script.assignments.len(), 1);
        assert_eq!(script.events.len(), 1);
        match &script.events[0].source {
            EventSource::Input { source, kind } => {
                assert_eq!(source, "mouse.left");
                assert!(matches!(kind, EventKind::Down));
            }
            other => panic!("ожидался входной источник, а не {:?}", other),
        }
        assert_eq!(script.events[0].body.len(), 2);
    }

    #[test]
    fn event_hold_takes_seconds() {
        // Точка внутри `hold(0.5)` не должна ломать разбор пути.
        let script = parse_script("on mic.talking.hold(0.5) { a = 1 }").unwrap();
        match &script.events[0].source {
            EventSource::Input { source, kind } => {
                assert_eq!(source, "mic.talking");
                assert!(matches!(kind, EventKind::Hold(value) if (*value - 0.5).abs() < 1e-9));
            }
            other => panic!("ожидался входной источник, а не {:?}", other),
        }
    }

    #[test]
    fn event_unknown_type_is_rejected() {
        assert!(parse_script("on mouse.left.tap { a = 1 }").is_err());
        assert!(parse_script("on mouse.left.down { a = 1").is_err());
        assert!(parse_script("on mouse.talking { a = 1 }").is_err());
    }

    #[test]
    fn trigger_declares_named_event() {
        let script = parse_script(
            "trigger kick = mouse.left.down\ntrigger breath = Mic.talking.relax(0.6)\non kick { a = 1 }",
        )
        .unwrap();
        assert_eq!(script.triggers.len(), 2);
        assert_eq!(script.triggers[0].name, "kick");
        assert_eq!(script.triggers[0].source, "mouse.left");
        assert!(matches!(&script.triggers[1].kind, EventKind::Relax(value) if (*value - 0.6).abs() < 1e-9));
        assert!(matches!(&script.events[0].source, EventSource::Named(name) if name == "kick"));
    }

    #[test]
    fn start_and_plain_input_parse() {
        let script = parse_script("on start { a = 0 }\non key.space.up { a = 1 }").unwrap();
        assert!(matches!(&script.events[0].source, EventSource::Start));
        match &script.events[1].source {
            EventSource::Input { source, kind } => {
                assert_eq!(source, "key.space");
                assert!(matches!(kind, EventKind::Up));
            }
            other => panic!("ожидался входной источник, а не {:?}", other),
        }
    }

    #[test]
    fn event_prefix_is_rejected_with_a_hint() {
        // Заголовок события один: `on модуль.вход.тип`. Старая запись без `on`
        // подсказывает правильную форму, а не молчит.
        let error = parse_script("event.mouse.left.down { a = 1 }").unwrap_err();
        assert!(error.message.contains("префикс 'event.' не нужен"), "{}", error.message);
        let error = parse_script("on event.key.space.up { a = 1 }").unwrap_err();
        assert!(error.message.contains("префикс 'event.' не нужен"), "{}", error.message);
    }

    #[test]
    fn event_object_assignment_is_not_a_block() {
        // Объект с именем `event` остаётся объектом: `event.x = 5` — присваивание,
        // а не заголовок события.
        let script = parse_script("event.x = 5").unwrap();
        assert!(script.events.is_empty());
        assert!(matches!(
            &script.assignments[0].0,
            AssignTarget::Foreign { object, param } if object == "event" && param == "x"
        ));
    }

    #[test]
    fn field_call_parses_as_input_field() {
        // `twitch.chat.message(-1)` — поле входа модуля, а не встроенная функция.
        let script = parse_script("text = twitch.chat.message(-1)").unwrap();
        let Statement::Assign(_, Expr::FieldCall { subject, field, args }) = &script.assignments[0] else {
            panic!("ожидался вызов поля входа: {:?}", script.assignments[0]);
        };
        assert_eq!(subject, "twitch.chat");
        assert_eq!(field, "message");
        assert_eq!(args.len(), 1);
        // Без скобок — обычный доступ к полю входа.
        let plain = parse_script("text = twitch.chat.message").unwrap();
        assert!(matches!(
            &plain.assignments[0],
            Statement::Assign(_, Expr::Member { .. })
        ));
        // Встроенные функции не перестали работать.
        assert!(matches!(
            &parse_script("text = fixed(mic.db, 2)").unwrap().assignments[0],
            Statement::Assign(_, Expr::Call { name, .. }) if name == "fixed"
        ));
    }

    #[test]
    fn foreign_assignment_parses() {
        let script = parse_script("head.rotation = 15\non mouse.left.down { head.x = 5 }").unwrap();
        assert!(matches!(
            &script.assignments[0].0,
            AssignTarget::Foreign { object, param } if object == "head" && param == "rotation"
        ));
        assert!(matches!(
            &script.events[0].body[0],
            Statement::Assign(AssignTarget::Foreign { object, param }, _)
                if object == "head" && param == "x"
        ));
    }

    #[test]
    fn commands_are_statements_of_event_blocks() {
        let script =
            parse_script("on start {\n  play()\n  seek(2.5)\n  text(\"привет\")\n}").unwrap();
        let body = &script.events[0].body;
        assert_eq!(body.len(), 3);
        assert!(matches!(&body[0], Statement::Call(call) if matches!(call.as_ref(), Expr::Call { name, .. } if name == "play")));
        assert!(matches!(&body[2], Statement::Call(call) if matches!(call.as_ref(), Expr::Call { args, .. } if matches!(args.first(), Some(Expr::Text(text)) if text == "привет"))));
    }

    #[test]
    fn command_outside_event_is_an_error() {
        let error = parse_script("play()").unwrap_err();
        assert!(error.message.contains("внутри блока события"));
    }

    #[test]
    fn text_after_event_block_is_reported() {
        // `on start {} text("…")` раньше молча терялся: человек видел «ни ошибки,
        // ни результата». Теперь это ошибка с местом.
        let error = parse_script("on start {} text(\"привет\")").unwrap_err();
        assert!(error.message.contains("после '}'"));
        assert_eq!(error.line, 1);

        // Комментарий после блока — обычное дело, он не ошибка.
        assert!(parse_script("on start {} // пусто").is_ok());
        // Тело в одну строку по-прежнему работает.
        assert!(parse_script("on start { a = 1 }").is_ok());
    }

    #[test]
    fn errors_carry_line_and_column() {
        let error = parse_script("x = 1\ny = 2 +\n").unwrap_err();
        assert_eq!(error.line, 2);
        assert!(error.column >= 1);
        assert!(!error.message.is_empty());
        let trigger_error = parse_script("trigger kick = down").unwrap_err();
        assert_eq!(trigger_error.line, 1);
    }

    #[test]
    fn duplicate_assignment_is_rejected() {
        assert!(parse_script("x = 1\nx = 2").is_err());
    }
}
