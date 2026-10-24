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
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Number(f64),
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
            _ => return Err(format!("неизвестный символ '{}' на позиции {}", c, i + 1)),
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

/// Условие, по которому срабатывает блок `on event.… { … }`.
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

/// Блок `on event.<модуль>.<вход>.<тип> { имя = выражение … }`.
#[derive(Debug, Clone)]
pub struct EventBlock {
    /// Вход-источник без префикса `event`: `mouse.left`, `mic.talking`.
    pub source: String,
    pub kind: EventKind,
    pub body: Vec<(String, Arc<Expr>)>,
}

/// Разобранный скрипт: обычные присваивания и блоки событий.
#[derive(Debug, Default)]
pub struct Script {
    pub assignments: Vec<(String, Arc<Expr>)>,
    pub events: Vec<EventBlock>,
}

fn valid_identifier(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Разбор заголовка `on event.mouse.left.down(…)`: вход и тип условия.
fn parse_event_header(header: &str, line: usize) -> Result<(String, EventKind), String> {
    let text = header.trim();
    let rest = text
        .strip_prefix("on")
        .ok_or_else(|| format!("строка {}: ожидалось 'on event.модуль.вход.тип'", line))?
        .trim_start();
    let path = rest.strip_prefix("event.").ok_or_else(|| {
        format!(
            "строка {}: после 'on' ожидалось 'event.модуль.вход.тип'",
            line
        )
    })?;
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() != 3 {
        return Err(format!(
            "строка {}: нужно 'event.модуль.вход.тип', а не '{}'",
            line, text
        ));
    }
    let module = parts[0].trim();
    let input = parts[1].trim();
    if !valid_identifier(module) || !valid_identifier(input) {
        return Err(format!(
            "строка {}: имя модуля и входа — латиница, цифры и '_'",
            line
        ));
    }
    let raw = parts[2].trim();
    let (name, argument) = match raw.split_once('(') {
        Some((name, tail)) => {
            let inner = tail.strip_suffix(')').ok_or_else(|| {
                format!("строка {}: у '{}' не закрыта скобка", line, raw)
            })?;
            (name.trim(), Some(inner.trim()))
        }
        None => (raw, None),
    };
    let mut seconds = 0.0;
    if matches!(name, "hold" | "relax") {
        if let Some(value) = argument {
            if !value.is_empty() {
                seconds = value.parse::<f64>().map_err(|_| {
                    format!("строка {}: время в '{}' должно быть числом", line, raw)
                })?;
                if !seconds.is_finite() || seconds < 0.0 {
                    return Err(format!(
                        "строка {}: время в '{}' не может быть отрицательным",
                        line, raw
                    ));
                }
            }
        }
    }
    let kind = match name {
        "down" => EventKind::Down,
        "up" => EventKind::Up,
        "change" => EventKind::Change,
        "hold" => EventKind::Hold(seconds),
        "relax" => EventKind::Relax(seconds),
        other => {
            return Err(format!(
                "строка {}: неизвестный тип события '{}'; ожидалось down, up, change, hold(сек) или relax(сек)",
                line, other
            ))
        }
    };
    Ok((format!("{}.{}", module, input), kind))
}

pub fn parse_script(source: &str) -> Result<Script, String> {
    let mut script = Script::default();
    let mut next_call_id = 0u32;
    let lines: Vec<&str> = source.lines().collect();
    let mut index = 0usize;
    while index < lines.len() {
        let line_number = index + 1;
        let line = lines[index]
            .split("//")
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if line.is_empty() {
            index += 1;
            continue;
        }
        // Блок события: `on event.<модуль>.<вход>.<тип> { … }`.
        if line.starts_with("on") && line[2..].trim_start().starts_with("event") {
            let open = line.find('{').ok_or_else(|| {
                format!("строка {}: у блока события нет '{{'", line_number)
            })?;
            let (event_source, kind) = parse_event_header(&line[..open], line_number)?;
            let mut raw_body: Vec<String> = Vec::new();
            let rest = &line[open + 1..];
            let mut closed = match rest.find('}') {
                Some(close) => {
                    raw_body.push(rest[..close].to_string());
                    true
                }
                None => {
                    raw_body.push(rest.to_string());
                    false
                }
            };
            if !closed {
                while index + 1 < lines.len() {
                    index += 1;
                    let trimmed = lines[index].split("//").next().unwrap_or("").trim();
                    if trimmed == "}" {
                        closed = true;
                        break;
                    }
                    if let Some(text) = trimmed.strip_suffix('}') {
                        raw_body.push(text.trim().to_string());
                        closed = true;
                        break;
                    }
                    raw_body.push(trimmed.to_string());
                }
                if !closed {
                    return Err(format!(
                        "строка {}: блок события не закрыт '}}'",
                        line_number
                    ));
                }
            }
            let mut body = Vec::new();
            for raw in raw_body {
                let text = raw.trim();
                if text.is_empty() {
                    continue;
                }
                let (name, expression) = text.split_once('=').ok_or_else(|| {
                    format!(
                        "строка {}: в блоке события ожидалось 'имя = выражение'",
                        line_number
                    )
                })?;
                let name = name.trim();
                if !valid_identifier(name) {
                    return Err(format!(
                        "строка {}: некорректное имя '{}'",
                        line_number, name
                    ));
                }
                let expr = parse_expression(expression.trim())
                    .map_err(|error| format!("строка {}: {}", line_number, error))?;
                let mut counter = CountCalls(next_call_id);
                counter.visit(&expr);
                next_call_id = counter.0;
                body.push((name.to_string(), Arc::new(expr)));
            }
            script.events.push(EventBlock {
                source: event_source,
                kind,
                body,
            });
            index += 1;
            continue;
        }
        let (name, expression) = line.split_once('=').ok_or_else(|| {
            format!(
                "строка {}: ожидалось присваивание 'имя = выражение'",
                line_number
            )
        })?;
        let name = name.trim();
        if !valid_identifier(name) {
            return Err(format!(
                "строка {}: некорректное имя '{}'; ожидался ASCII-идентификатор",
                line_number, name
            ));
        }
        if script
            .assignments
            .iter()
            .any(|(existing, _)| existing == name)
        {
            return Err(format!(
                "строка {}: параметр '{}' присваивается дважды",
                line_number, name
            ));
        }
        let expr = parse_expression(expression.trim())
            .map_err(|error| format!("строка {}: {}", line_number, error))?;
        // IDs are unique within one script. They are scoped by node in the runtime.
        let mut counter = CountCalls(next_call_id);
        counter.visit(&expr);
        next_call_id = counter.0;
        script.assignments.push((name.to_string(), Arc::new(expr)));
        index += 1;
    }
    Ok(script)
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
            "a = 0\non event.mouse.left.down {\n  a = !a\n  b = 1\n}\n",
        )
        .unwrap();
        assert_eq!(script.assignments.len(), 1);
        assert_eq!(script.events.len(), 1);
        assert_eq!(script.events[0].source, "mouse.left");
        assert!(matches!(script.events[0].kind, EventKind::Down));
        assert_eq!(script.events[0].body.len(), 2);
    }

    #[test]
    fn event_hold_takes_seconds() {
        let script = parse_script("on event.mic.talking.hold(0.5) { a = 1 }").unwrap();
        assert_eq!(script.events[0].source, "mic.talking");
        assert!(matches!(script.events[0].kind, EventKind::Hold(value) if (value - 0.5).abs() < 1e-9));
    }

    #[test]
    fn event_unknown_type_is_rejected() {
        assert!(parse_script("on event.mouse.left.tap { a = 1 }").is_err());
        assert!(parse_script("on event.mouse.left.down { a = 1").is_err());
    }

    #[test]
    fn duplicate_assignment_is_rejected() {
        assert!(parse_script("x = 1\nx = 2").is_err());
    }
}
